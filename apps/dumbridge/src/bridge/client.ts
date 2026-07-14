import { type Duration, Effect, Option, Schema, Stream } from "effect";
import {
  materializePull,
  type PullError,
  type PullFileEntry,
  PullIOError,
  PullNotFoundError,
  PullPathError,
  type PullRead,
  PullRemoteLimitError,
  type PullResult,
  PullSourceChangedError,
  PullSymlinkError,
  resolvePullDestination,
} from "../pull/transfer";
import { joinBytes, sendFrames, WireEventReader } from "./channel";
import { type BridgeLinkError, type Capability, parseBridgeLink } from "./link";
import {
  BridgeLocator,
  type BridgeSession,
  type BridgeTransport,
} from "./transport";
import {
  type BridgeRequest,
  makePullResponseSession,
  makeRunResponseSession,
  type PullFailureCode,
  type PullResponseEvent,
} from "./wire";

const defaultPullDeadline: Duration.Input = "125 minutes";
const defaultRunDeadline: Duration.Input = "2 minutes";
const connectRetryDelay: Duration.Input = "100 millis";
const maximumConnectAttempts = 2;

const ClientOperation = Schema.Literals([
  "bridge-link",
  "connect",
  "pull-response",
  "request",
  "run-response",
]);

export class BridgeClientError extends Schema.TaggedErrorClass<BridgeClientError>()(
  "BridgeClientError",
  {
    message: Schema.String,
    operation: ClientOperation,
  }
) {}

export interface RemoteRunResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly truncated: boolean;
}

export interface RemotePullResult extends PullResult {
  readonly destination: string;
}

const clientError = (operation: typeof ClientOperation.Type, message: string) =>
  new BridgeClientError({ message, operation });

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

const decodeLink = (link: string) =>
  Effect.fromResult(parseBridgeLink(link)).pipe(
    Effect.mapError((_error: BridgeLinkError) =>
      clientError("bridge-link", "DUMBRIDGE_LINK is invalid.")
    )
  );

const openSession = (transport: BridgeTransport, link: string) =>
  Effect.gen(function* () {
    const decoded = yield* decodeLink(link);
    const session = yield* transport
      .connect(BridgeLocator.fromString(decoded.locator))
      .pipe(
        Effect.mapError(() =>
          clientError("connect", "Could not connect to the bridge process.")
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
    Effect.mapError(() =>
      clientError("request", "Could not send the bridge request.")
    )
  );

const nextClientEvent = <A>(
  reader: WireEventReader<A>,
  operation: "run-response"
) =>
  reader
    .next()
    .pipe(
      Effect.mapError(() =>
        clientError(operation, "The bridge returned an invalid response.")
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
            Effect.mapError(() =>
              clientError("run-response", "Could not open the run response.")
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

const pullReadError = (path: string) =>
  new PullIOError({ operation: "read bridge response", path });

const remotePullError = (code: PullFailureCode, path: string): PullError => {
  switch (code) {
    case "invalid-path":
      return new PullPathError({
        path,
        reason: "remote path was rejected",
      });
    case "not-found":
      return new PullNotFoundError({ path });
    case "symlink":
      return new PullSymlinkError({ path });
    case "limit":
      return new PullRemoteLimitError({ path });
    case "source-changed":
      return new PullSourceChangedError({ path });
    case "io":
      return pullReadError(path);
    default:
      return pullReadError(path);
  }
};

const nextPullEvent = (
  reader: WireEventReader<PullResponseEvent>,
  path: string,
  signal?: AbortSignal
): Effect.Effect<Option.Option<PullResponseEvent>, PullError> => {
  if (signal?.aborted) {
    return pullReadError(path);
  }
  return reader.next().pipe(
    Effect.mapError(() => pullReadError(path)),
    Effect.flatMap((event) =>
      Option.isSome(event) && event.value.type === "pull-error"
        ? Effect.fail(remotePullError(event.value.code, path))
        : Effect.succeed(event)
    )
  );
};

const finishPullResponse = (
  reader: WireEventReader<PullResponseEvent>,
  path: string,
  signal?: AbortSignal
): Effect.Effect<void, PullError> =>
  Effect.gen(function* () {
    const complete = yield* nextPullEvent(reader, path, signal);
    if (Option.isNone(complete) || complete.value.type !== "complete") {
      return yield* pullReadError(path);
    }
    const end = yield* nextPullEvent(reader, path, signal);
    if (Option.isSome(end)) {
      return yield* pullReadError(path);
    }
  });

const makeRemoteRead =
  (
    reader: WireEventReader<PullResponseEvent>,
    finalFilePath: string | undefined
  ): PullRead =>
  (entry: PullFileEntry, signal: AbortSignal) => {
    const start = nextPullEvent(reader, entry.path, signal).pipe(
      Effect.flatMap((event) => {
        if (
          Option.isNone(event) ||
          event.value.type !== "file-start" ||
          event.value.path !== entry.path ||
          event.value.size !== entry.size
        ) {
          return pullReadError(entry.path);
        }
        return Effect.void;
      })
    );

    return Stream.unwrap(
      start.pipe(
        Effect.map(() =>
          Stream.unfold(undefined, () =>
            nextPullEvent(reader, entry.path, signal).pipe(
              Effect.flatMap((event) => {
                if (Option.isNone(event)) {
                  return pullReadError(entry.path);
                }
                if (event.value.type === "file-chunk") {
                  return Effect.succeed([
                    event.value.payload,
                    undefined,
                  ] as const);
                }
                if (event.value.type !== "file-end") {
                  return pullReadError(entry.path);
                }
                return entry.path === finalFilePath
                  ? finishPullResponse(reader, entry.path, signal).pipe(
                      Effect.as(undefined)
                    )
                  : Effect.succeed(undefined);
              })
            )
          )
        )
      )
    );
  };

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
          const destination = yield* Effect.try({
            catch: (cause) =>
              cause instanceof PullPathError
                ? cause
                : new PullPathError({
                    path: options.remotePath,
                    reason: "path could not be validated",
                  }),
            try: () =>
              resolvePullDestination(options.remotePath, options.destination),
          });
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
            Effect.mapError(() =>
              clientError("pull-response", "Could not open the pull response.")
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
