import { type Duration, Effect, Option, Schema, Stream } from "effect";
import { ServedRoot, ServedRootChangedError } from "../files/served-root";
import { type PullSource, preparePull } from "../pull/transfer";
import {
  SafeShell,
  ShellLimitExceededError,
  type ShellResult,
} from "../shell/safe-shell";
import { sendFrame, WireEventReader } from "./channel";
import {
  type BridgeLink,
  type Capability,
  encodeBridgeLink,
  mintCapability,
} from "./link";
import {
  type BridgeListener,
  BridgeListenerClosedError,
  type BridgeSession,
  type BridgeTransport,
} from "./transport";
import {
  type BridgeRequest,
  makeRequestSession,
  type PullFailureCode,
  type PullResponseEvent,
  type RunResponseEvent,
} from "./wire";

const responseChunkBytes = 64 * 1024;
const initialAcceptBackoff: Duration.Input = "10 millis";
const maximumAcceptBackoffMillis = 1000;
const defaultConcurrentSessions = 4;
const maximumConcurrentSessions = 8;

interface BridgeServerDeadlines {
  readonly pull: Duration.Input;
  readonly request: Duration.Input;
  readonly run: Duration.Input;
}

const defaultDeadlines: BridgeServerDeadlines = {
  pull: "2 hours",
  request: "30 seconds",
  run: "1 minute",
};

class BridgeSessionError extends Schema.TaggedErrorClass<BridgeSessionError>()(
  "BridgeSessionError",
  { message: Schema.String }
) {}

interface BridgeServer {
  readonly link: BridgeLink;
  readonly serve: Effect.Effect<never, BridgeListenerClosedError>;
}

const sessionError = (message: string) => new BridgeSessionError({ message });

const readRequest = (session: BridgeSession, capability: Capability) =>
  Effect.gen(function* () {
    const decoder = yield* Effect.fromResult(makeRequestSession(capability));
    const reader = new WireEventReader(session, decoder);
    let request: BridgeRequest | undefined;
    let next = yield* reader.next();
    while (Option.isSome(next)) {
      if (request !== undefined) {
        return yield* sessionError("Bridge request contained extra frames.");
      }
      request = next.value;
      next = yield* reader.next();
    }
    if (request === undefined) {
      return yield* sessionError("Bridge request was incomplete.");
    }
    return request;
  });

const withSessionDeadline = <A, E, R>(
  operation: "pull" | "request" | "run",
  duration: Duration.Input,
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => sessionError(`Bridge ${operation} deadline exceeded.`),
    })
  );

const byteChunks = (bytes: Uint8Array) => {
  const chunks: Uint8Array[] = [];
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += responseChunkBytes
  ) {
    chunks.push(bytes.slice(offset, offset + responseChunkBytes));
  }
  return chunks;
};

const sendOutput = (
  session: BridgeSession,
  type: "stderr" | "stdout",
  text: string
) =>
  Effect.forEach(
    byteChunks(new TextEncoder().encode(text)),
    (payload) =>
      sendFrame(session, { payload, type } satisfies RunResponseEvent),
    { concurrency: 1, discard: true }
  );

interface CompletedShellResult extends ShellResult {
  readonly truncated: boolean;
}

const failedShellResult = (message: string): CompletedShellResult => ({
  exitCode: 1,
  stderr: `dumbridge: ${message}\n`,
  stdout: "",
  truncated: true,
});

const executeShell = (shell: SafeShell, script: string) =>
  shell.execute(script).pipe(
    Effect.map((result) => ({ ...result, truncated: false })),
    Effect.catch((error) =>
      error instanceof ServedRootChangedError
        ? Effect.fail(error)
        : Effect.succeed(
            failedShellResult(
              error instanceof ShellLimitExceededError
                ? error.message
                : "remote read shell failed"
            )
          )
    ),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.succeed(
          failedShellResult("remote read shell deadline exceeded")
        ),
    })
  );

const handleRun = (session: BridgeSession, shell: SafeShell, script: string) =>
  Effect.gen(function* () {
    const result = yield* executeShell(shell, script);
    yield* sendOutput(session, "stdout", result.stdout);
    yield* sendOutput(session, "stderr", result.stderr);
    yield* sendFrame(session, {
      code: Math.max(0, Math.min(255, result.exitCode)),
      truncated: result.truncated,
      type: "exit",
    });
    yield* session.finish;
  });

const sendPullSource = (session: BridgeSession, source: PullSource) =>
  Effect.gen(function* () {
    yield* sendFrame(session, {
      manifest: source.manifest,
      type: "manifest",
    });

    for (const entry of source.manifest.entries) {
      if (entry.kind === "directory") {
        continue;
      }
      yield* sendFrame(session, {
        path: entry.path,
        size: entry.size,
        type: "file-start",
      });
      yield* Effect.acquireUseRelease(
        Effect.sync(() => new AbortController()),
        (controller) => {
          let offset = 0;
          return Stream.runForEach(
            source.read(entry, controller.signal),
            (payload) => {
              const frame = {
                offset,
                payload,
                type: "file-chunk",
              } satisfies PullResponseEvent;
              offset += payload.byteLength;
              return sendFrame(session, frame);
            }
          );
        },
        (controller) => Effect.sync(() => controller.abort())
      );
      yield* sendFrame(session, {
        digest: entry.digest,
        type: "file-end",
      });
    }

    yield* source.verify;
    yield* sendFrame(session, { type: "complete" });
    yield* session.finish;
  });

const pullFailureCode = (error: unknown): PullFailureCode | undefined => {
  if (typeof error !== "object" || error === null || !("_tag" in error)) {
    return;
  }

  const tag: unknown = error._tag;
  if (typeof tag !== "string") {
    return;
  }

  switch (tag) {
    case "PullPathError":
      return "invalid-path";
    case "PullNotFoundError":
      return "not-found";
    case "PullSymlinkError":
      return "symlink";
    case "PullLimitError":
      return "limit";
    case "PullIntegrityError":
    case "PullSourceChangedError":
    case "ServedRootChangedError":
      return "source-changed";
    case "PullIOError":
      return "io";
    default:
      return;
  }
};

const sendPullFailure = (session: BridgeSession, code: PullFailureCode) =>
  sendFrame(session, { code, type: "pull-error" }).pipe(
    Effect.flatMap(() => session.finish)
  );

const handlePull = (
  session: BridgeSession,
  root: ServedRoot,
  remotePath: string
) =>
  Effect.gen(function* () {
    yield* root.verify();
    const source = yield* preparePull({
      remotePath,
      servedRoot: root,
    });
    yield* sendPullSource(session, source);
  }).pipe(
    Effect.catch((error) => {
      const code = pullFailureCode(error);
      return code === undefined
        ? Effect.fail(error)
        : sendPullFailure(session, code);
    })
  );

const handleSession = (
  session: BridgeSession,
  capability: Capability,
  root: ServedRoot,
  shell: SafeShell,
  deadlines: BridgeServerDeadlines
) =>
  withSessionDeadline(
    "request",
    deadlines.request,
    readRequest(session, capability)
  ).pipe(
    Effect.flatMap((request) =>
      withSessionDeadline(
        request.type,
        request.type === "run" ? deadlines.run : deadlines.pull,
        request.type === "run"
          ? handleRun(session, shell, request.script)
          : handlePull(session, root, request.remotePath)
      )
    )
  );

const serveLoop = (
  listener: BridgeListener,
  capability: Capability,
  root: ServedRoot,
  shell: SafeShell,
  deadlines: BridgeServerDeadlines
): Effect.Effect<never, BridgeListenerClosedError> => {
  const nextBackoffMillis = (failures: number) =>
    Math.min(maximumAcceptBackoffMillis, 10 * 2 ** Math.min(failures, 7));

  const loop = (
    consecutiveFailures: number
  ): Effect.Effect<never, BridgeListenerClosedError> =>
    Effect.scoped(
      listener.accept.pipe(
        Effect.flatMap((session) =>
          handleSession(session, capability, root, shell, deadlines).pipe(
            Effect.ensuring(session.close),
            Effect.catch(() => Effect.void)
          )
        )
      )
    ).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          error instanceof BridgeListenerClosedError
            ? Effect.fail(error)
            : Effect.sleep(
                consecutiveFailures === 0
                  ? initialAcceptBackoff
                  : `${nextBackoffMillis(consecutiveFailures)} millis`
              ).pipe(
                Effect.flatMap(() =>
                  Effect.suspend(() => loop(consecutiveFailures + 1))
                )
              ),
        onSuccess: () => Effect.suspend(() => loop(0)),
      })
    );

  return loop(0);
};

const serveConcurrently = (
  listener: BridgeListener,
  capability: Capability,
  root: ServedRoot,
  shell: SafeShell,
  deadlines: BridgeServerDeadlines,
  concurrency: number
): Effect.Effect<never, BridgeListenerClosedError> =>
  Effect.forEach(
    Array.from({ length: concurrency }),
    () => serveLoop(listener, capability, root, shell, deadlines),
    { concurrency: "unbounded", discard: true }
  ).pipe(Effect.flatMap(() => Effect.never));

const normalizeConcurrentSessions = (value: number | undefined) =>
  value === undefined || !Number.isSafeInteger(value)
    ? defaultConcurrentSessions
    : Math.max(1, Math.min(maximumConcurrentSessions, value));

export const openBridge = Effect.fn("BridgeServer.open")(
  (options: {
    readonly deadlines?: Partial<BridgeServerDeadlines>;
    readonly maxConcurrentSessions?: number;
    readonly root: string;
    readonly transport: BridgeTransport;
  }) =>
    Effect.gen(function* () {
      const root = yield* ServedRoot.make(options.root);
      const shell = yield* SafeShell.make(root);
      const listener = yield* options.transport.listen;
      const capability = mintCapability();
      const link = yield* Effect.fromResult(
        encodeBridgeLink({
          capability,
          locator: listener.locator.toString(),
          transport: "iroh",
        })
      );

      return {
        link,
        serve: serveConcurrently(
          listener,
          capability,
          root,
          shell,
          {
            ...defaultDeadlines,
            ...options.deadlines,
          },
          normalizeConcurrentSessions(options.maxConcurrentSessions)
        ),
      } satisfies BridgeServer;
    })
);
