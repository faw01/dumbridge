import {
  type BridgeKeyError,
  type BridgeKeyExpiredError,
  type Capability,
  checkBridgeKeyExpiry,
  parseBridgeKey,
} from "@dumbridge/bridge-key";
import {
  type BridgeDeadlineExceededError,
  BridgeLocator,
  type BridgeLocatorInvalidError,
  type BridgeProxyConfigurationError,
  type BridgeProxyUnsupportedError,
  type BridgeReadError,
  type BridgeSession,
  type BridgeTransport,
} from "@dumbridge/bridge-transport";
import {
  materializePull,
  type PullError,
  type PullFileEntry,
  PullIOError,
  type PullResult,
  resolvePullDestination,
} from "@dumbridge/pull-transfer";
import {
  type BridgeRequest,
  encodeFrame,
  makePullResponseSession,
  makeRunResponseSession,
  type RejectCode,
  type RunResponseEvent,
  type WireDecodeError,
} from "@dumbridge/wire";
import { Clock, type Duration, Effect, Option, Schema } from "effect";
import { joinBytes, WireEventReader } from "./channel";
import {
  finishPullResponse,
  makeRemoteRead,
  nextPullEvent,
} from "./pull-response";

const defaultPullDeadline: Duration.Input = "125 minutes";
const defaultRunDeadline: Duration.Input = "2 minutes";
const connectRetryDelay: Duration.Input = "100 millis";
const maximumConnectAttempts = 2;

const ClientOperation = Schema.Literals([
  "bridge-key",
  "connect",
  "pull-response",
  "request",
  "run-response",
]);

class BridgeClientError extends Schema.TaggedErrorClass<BridgeClientError>()(
  "BridgeClientError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
    operation: ClientOperation,
  }
) {}

type DeterministicConnectError =
  | BridgeLocatorInvalidError
  | BridgeProxyConfigurationError
  | BridgeProxyUnsupportedError;

interface RemoteRunResult {
  readonly exitCode: number;
  readonly served: string | undefined;
  readonly stderr: string;
  readonly stdout: string;
  readonly truncated: boolean;
}

interface RemotePullResult extends PullResult {
  readonly destination: string;
}

const clientError = (
  operation: typeof ClientOperation.Type,
  message: string,
  cause?: unknown
) => new BridgeClientError({ cause, message, operation });

const retryConnect = <A, E, R>(
  attempt: () => Effect.Effect<A, E, R>,
  remaining = maximumConnectAttempts
): Effect.Effect<A, E, R> =>
  Effect.suspend(attempt).pipe(
    Effect.catch((error) =>
      remaining > 1 &&
      error instanceof BridgeClientError &&
      error.operation === "connect"
        ? Effect.sleep(connectRetryDelay).pipe(
            Effect.flatMap(() => retryConnect(attempt, remaining - 1))
          )
        : Effect.fail(error)
    )
  );

const withClientDeadline = <A, E, R>(
  operation: "pull-response" | "run-response",
  duration: Duration.Input,
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () =>
        clientError(
          operation,
          operation === "run-response"
            ? "The bridge run response deadline was exceeded."
            : "The bridge pull response deadline was exceeded."
        ),
    })
  );

const decodeKey = (link: string) =>
  Effect.fromResult(parseBridgeKey(link)).pipe(
    Effect.mapError((error: BridgeKeyError) =>
      clientError("bridge-key", "The bridge key is invalid.", error)
    )
  );

const transientConnectFailure = (error: unknown) =>
  clientError(
    "connect",
    "The bridge process is unreachable. Check that dumbridge serve is still running on the local machine.",
    error
  );

const rejectMessages: Record<RejectCode, string> = {
  "expired-key":
    "The bridge rejected the bridge key: the key has expired. Run dumbridge serve again to mint a fresh key.",
  "invalid-key":
    "The bridge rejected the bridge key: the key does not match this bridge. Copy the current key printed by dumbridge serve.",
};

const rejectedError = (code: RejectCode) =>
  clientError("bridge-key", rejectMessages[code]);

const openSession = (transport: BridgeTransport, link: string) =>
  Effect.gen(function* () {
    const decoded = yield* decodeKey(link);
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.fromResult(checkBridgeKeyExpiry(decoded.expiresAt, now));
    const session = yield* transport
      .connect(BridgeLocator.fromString(decoded.locator))
      .pipe(
        Effect.catchTags({
          BridgeConnectError: transientConnectFailure,
          BridgeDeadlineExceededError: transientConnectFailure,
        })
      );
    return { capability: decoded.capability, session };
  });

const requestSendFailure = (error: unknown) =>
  clientError("request", "Could not send the bridge request.", error);

// Local encoding failures fail immediately: nothing was sent, so no reject
// frame can be waiting. Transport failures are deferred instead, because a
// bridge that rejects the key may stop reading mid-request and its reject
// frame explains the refusal better than the broken write; the send failure
// stays the root cause when no reject arrives. Finish is still attempted
// after a failed write so the bridge sees end-of-stream rather than waiting
// out its request deadline.
const finishRequest = (
  session: BridgeSession,
  capability: Capability,
  request: BridgeRequest
): Effect.Effect<BridgeClientError | undefined, BridgeClientError> =>
  Effect.gen(function* () {
    const authFrame = yield* Effect.fromResult(
      encodeFrame({ capability, type: "auth" })
    ).pipe(Effect.mapError(requestSendFailure));
    const requestFrame = yield* Effect.fromResult(encodeFrame(request)).pipe(
      Effect.mapError(requestSendFailure)
    );

    const writeFailure = yield* session.write(authFrame).pipe(
      Effect.flatMap(() => session.write(requestFrame)),
      Effect.as<unknown>(undefined),
      Effect.catch((error) => Effect.succeed<unknown>(error))
    );
    const finishFailure = yield* session.finish.pipe(
      Effect.as<unknown>(undefined),
      Effect.catch((error) => Effect.succeed<unknown>(error))
    );

    const failure = writeFailure ?? finishFailure;
    return failure === undefined ? undefined : requestSendFailure(failure);
  });

type ResponseReadError =
  | WireDecodeError
  | BridgeDeadlineExceededError
  | BridgeReadError;

const invalidResponseMessage = "The bridge returned an invalid response.";
const responseEndedEarlyMessage =
  "The bridge ended the response before it completed. The serve process may have stopped or refused the query; check dumbridge serve on the local machine.";
const connectionFailedMessage =
  "The bridge connection failed while reading the response. Check that dumbridge serve is still running on the local machine.";

// One user string per response read failure; the compiler keeps the table
// exhaustive. A stream the bridge ended early and a lost connection are
// reported as such instead of masquerading as a malformed response.
const responseReadMessages: Record<ResponseReadError["_tag"], string> = {
  AuthenticationError: invalidResponseMessage,
  BridgeDeadlineExceededError: connectionFailedMessage,
  BridgeReadError: connectionFailedMessage,
  FrameTooLargeError: invalidResponseMessage,
  IllegalFrameError: invalidResponseMessage,
  IncompleteFrameError: responseEndedEarlyMessage,
  IncompleteSessionError: responseEndedEarlyMessage,
  MalformedFrameError: invalidResponseMessage,
  UnknownFrameTypeError: invalidResponseMessage,
  UnsupportedProtocolError: invalidResponseMessage,
  WireLimitExceededError: invalidResponseMessage,
};

// Pull reads flatten wire and transport failures into a PullIOError so they
// can travel through materializePull's PullError channel; the attached cause
// carries the original failure back out, where the same message table
// reports it with run-response fidelity.
const pullReadClientError = (error: unknown): BridgeClientError | undefined => {
  if (!(error instanceof PullIOError) || error.cause === undefined) {
    return;
  }
  const cause: unknown = error.cause;
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("_tag" in cause) ||
    typeof cause._tag !== "string" ||
    !Object.hasOwn(responseReadMessages, cause._tag)
  ) {
    return;
  }
  return clientError(
    "pull-response",
    responseReadMessages[cause._tag as ResponseReadError["_tag"]],
    cause
  );
};

const nextClientEvent = <A>(
  reader: WireEventReader<A>,
  operation: "run-response"
) =>
  reader
    .next()
    .pipe(
      Effect.mapError((error) =>
        clientError(operation, responseReadMessages[error._tag], error)
      )
    );

interface CollectedRunResponse {
  readonly exitCode: number | undefined;
  readonly reject: RejectCode | undefined;
  readonly served: string | undefined;
  readonly stderr: string;
  readonly stdout: string;
  readonly truncated: boolean;
}

const collectRunResponse = <E>(
  nextEvent: () => Effect.Effect<Option.Option<RunResponseEvent>, E>
): Effect.Effect<CollectedRunResponse, E> =>
  Effect.gen(function* () {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let served: string | undefined;
    let exitCode: number | undefined;
    let truncated = false;

    let next = yield* nextEvent();
    while (Option.isSome(next)) {
      if (next.value.type === "reject") {
        return {
          exitCode,
          reject: next.value.code,
          served,
          stderr: "",
          stdout: "",
          truncated,
        };
      }
      if (next.value.type === "banner") {
        ({ served } = next.value);
      } else if (next.value.type === "stdout") {
        stdout.push(next.value.payload);
      } else if (next.value.type === "stderr") {
        stderr.push(next.value.payload);
      } else if (next.value.type === "exit") {
        ({ code: exitCode, truncated } = next.value);
      }
      next = yield* nextEvent();
    }

    return {
      exitCode,
      reject: undefined,
      served,
      stderr: new TextDecoder().decode(joinBytes(stderr)),
      stdout: new TextDecoder().decode(joinBytes(stdout)),
      truncated,
    };
  });

export const runRemote = Effect.fn("BridgeClient.run")(
  (options: {
    readonly deadline?: Duration.Input;
    readonly link: string;
    readonly script: string;
    readonly transport: BridgeTransport;
  }): Effect.Effect<
    RemoteRunResult,
    BridgeClientError | BridgeKeyExpiredError | DeterministicConnectError
  > =>
    retryConnect(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const { capability, session } = yield* openSession(
            options.transport,
            options.link
          );
          yield* Effect.addFinalizer(() => session.close);
          const requestFailure = yield* finishRequest(session, capability, {
            script: options.script,
            type: "run",
          });

          const decoder = yield* Effect.fromResult(
            makeRunResponseSession()
          ).pipe(
            Effect.mapError((error) =>
              clientError(
                "run-response",
                "Could not open the run response.",
                error
              )
            )
          );
          const reader = new WireEventReader(session, decoder);
          const collected = yield* collectRunResponse(() =>
            nextClientEvent(reader, "run-response").pipe(
              Effect.mapError((error) => requestFailure ?? error)
            )
          );

          if (collected.reject !== undefined) {
            return yield* rejectedError(collected.reject);
          }
          if (collected.exitCode === undefined) {
            return yield* requestFailure ??
              clientError(
                "run-response",
                "The bridge run response was incomplete."
              );
          }
          return {
            exitCode: collected.exitCode,
            served: collected.served,
            stderr: collected.stderr,
            stdout: collected.stdout,
            truncated: collected.truncated,
          };
        })
      )
    ).pipe((effect) =>
      withClientDeadline(
        "run-response",
        options.deadline ?? defaultRunDeadline,
        effect
      )
    )
);

export const pullRemote = Effect.fn("BridgeClient.pull")(
  (options: {
    readonly deadline?: Duration.Input;
    readonly destination?: string;
    readonly link: string;
    readonly remotePath: string;
    readonly transport: BridgeTransport;
  }): Effect.Effect<
    RemotePullResult,
    | BridgeClientError
    | BridgeKeyExpiredError
    | DeterministicConnectError
    | PullError
  > =>
    retryConnect(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const destination = yield* Effect.fromResult(
            resolvePullDestination(options.remotePath, options.destination)
          );
          const { capability, session } = yield* openSession(
            options.transport,
            options.link
          );
          yield* Effect.addFinalizer(() => session.close);
          const requestFailure = yield* finishRequest(session, capability, {
            remotePath: options.remotePath,
            type: "pull",
          });

          const decoder = yield* Effect.fromResult(
            makePullResponseSession()
          ).pipe(
            Effect.mapError((error) =>
              clientError(
                "pull-response",
                "Could not open the pull response.",
                error
              )
            )
          );
          const reader = new WireEventReader(session, decoder);
          const first = yield* nextPullEvent(reader, options.remotePath).pipe(
            Effect.mapError((error) => requestFailure ?? error)
          );
          if (Option.isSome(first) && first.value.type === "reject") {
            return yield* rejectedError(first.value.code);
          }
          if (Option.isNone(first) || first.value.type !== "manifest") {
            return yield* requestFailure ??
              clientError(
                "pull-response",
                "The bridge pull response was incomplete."
              );
          }

          const files = first.value.manifest.entries.filter(
            (entry): entry is PullFileEntry => entry.kind === "file"
          );
          const finalFilePath = files.at(-1)?.path;
          if (finalFilePath === undefined) {
            yield* finishPullResponse(reader, options.remotePath);
          }

          const result = yield* materializePull({
            destination,
            manifest: first.value.manifest,
            read: makeRemoteRead(reader, finalFilePath),
          });
          return { ...result, destination };
        })
      )
    ).pipe(
      Effect.mapError((error) => pullReadClientError(error) ?? error),
      (effect) =>
        withClientDeadline(
          "pull-response",
          options.deadline ?? defaultPullDeadline,
          effect
        )
    )
);
