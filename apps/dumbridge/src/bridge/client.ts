import {
  type BridgeKeyError,
  type Capability,
  parseBridgeKey,
} from "@dumbridge/bridge-key";
import {
  BridgeLocator,
  type BridgeSession,
  type BridgeTransport,
} from "@dumbridge/bridge-transport";
import {
  materializePull,
  type PullError,
  type PullFileEntry,
  type PullResult,
  resolvePullDestination,
} from "@dumbridge/pull-transfer";
import {
  type BridgeRequest,
  makePullResponseSession,
  makeRunResponseSession,
} from "@dumbridge/wire";
import { type Duration, Effect, Option, Schema } from "effect";
import { joinBytes, sendFrames, WireEventReader } from "./channel";
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

interface RemoteRunResult {
  readonly exitCode: number;
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
      clientError("bridge-key", "DUMBRIDGE_KEY is invalid.", error)
    )
  );

const openSession = (transport: BridgeTransport, link: string) =>
  Effect.gen(function* () {
    const decoded = yield* decodeKey(link);
    const session = yield* transport
      .connect(BridgeLocator.fromString(decoded.locator))
      .pipe(
        Effect.mapError((error) =>
          clientError(
            "connect",
            "Could not connect to the bridge process.",
            error
          )
        )
      );
    return { capability: decoded.capability, session };
  });

const finishRequest = (
  session: BridgeSession,
  capability: Capability,
  request: BridgeRequest
) =>
  sendFrames(session, [{ capability, type: "auth" }, request]).pipe(
    Effect.flatMap(() => session.finish),
    Effect.mapError((error) =>
      clientError("request", "Could not send the bridge request.", error)
    )
  );

const nextClientEvent = <A>(
  reader: WireEventReader<A>,
  operation: "run-response"
) =>
  reader
    .next()
    .pipe(
      Effect.mapError((error) =>
        clientError(
          operation,
          "The bridge returned an invalid response.",
          error
        )
      )
    );

export const runRemote = Effect.fn("BridgeClient.run")(
  (options: {
    readonly deadline?: Duration.Input;
    readonly link: string;
    readonly script: string;
    readonly transport: BridgeTransport;
  }): Effect.Effect<RemoteRunResult, BridgeClientError> =>
    retryConnect(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const { capability, session } = yield* openSession(
            options.transport,
            options.link
          );
          yield* Effect.addFinalizer(() => session.close);
          yield* finishRequest(session, capability, {
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
          const stdout: Uint8Array[] = [];
          const stderr: Uint8Array[] = [];
          let exitCode: number | undefined;
          let truncated = false;

          let next = yield* nextClientEvent(reader, "run-response");
          while (Option.isSome(next)) {
            if (next.value.type === "stdout") {
              stdout.push(next.value.payload);
            } else if (next.value.type === "stderr") {
              stderr.push(next.value.payload);
            } else if (next.value.type === "exit") {
              ({ code: exitCode, truncated } = next.value);
            }
            next = yield* nextClientEvent(reader, "run-response");
          }

          if (exitCode === undefined) {
            return yield* clientError(
              "run-response",
              "The bridge run response was incomplete."
            );
          }
          return {
            exitCode,
            stderr: new TextDecoder().decode(joinBytes(stderr)),
            stdout: new TextDecoder().decode(joinBytes(stdout)),
            truncated,
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
  }): Effect.Effect<RemotePullResult, BridgeClientError | PullError> =>
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
          yield* finishRequest(session, capability, {
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
          const first = yield* nextPullEvent(reader, options.remotePath);
          if (Option.isNone(first) || first.value.type !== "manifest") {
            return yield* clientError(
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
    ).pipe((effect) =>
      withClientDeadline(
        "pull-response",
        options.deadline ?? defaultPullDeadline,
        effect
      )
    )
);
