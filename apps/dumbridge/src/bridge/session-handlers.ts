import type { BridgeSession } from "@dumbridge/bridge-transport";
import {
  type PullErrorTag,
  type PullSource,
  preparePull,
} from "@dumbridge/pull-transfer";
import type { SafeShell, ShellResult } from "@dumbridge/safe-shell";
import type { ServedRoot } from "@dumbridge/served-root";
import {
  encodeFrame,
  FrameTooLargeError,
  type PullFailureCode,
  type PullResponseEvent,
  type RejectCode,
  type RunResponseEvent,
} from "@dumbridge/wire";
import { type Duration, Effect, Result, Schema, Stream } from "effect";
import { sendFrame } from "./channel";

const responseChunkBytes = 64 * 1024;

export class BridgeSessionError extends Schema.TaggedErrorClass<BridgeSessionError>()(
  "BridgeSessionError",
  { message: Schema.String }
) {}

export const sessionError = (message: string) =>
  new BridgeSessionError({ message });

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

// The served root errors stay in the error channel so the session terminates
// without a response; inference proves the pass-through.
const executeShell = (shell: SafeShell, script: string) =>
  shell.execute(script).pipe(
    Effect.map((result) => ({ ...result, truncated: false })),
    Effect.catchTags({
      ShellExecutionError: () =>
        Effect.succeed(failedShellResult("remote read shell failed")),
      ShellLimitExceededError: (error) =>
        Effect.succeed(failedShellResult(error.message)),
    })
  );

export type BannerSender = (
  session: BridgeSession
) => Effect.Effect<void, Effect.Error<ReturnType<typeof sendFrame>>>;

export const handleRun = (
  session: BridgeSession,
  shell: SafeShell,
  script: string,
  sendBanner: BannerSender
) =>
  Effect.gen(function* () {
    const result = yield* executeShell(shell, script);
    // Sent only after the shell produced a response, so the one banner is
    // not spent on a session that terminates without answering.
    yield* sendBanner(session);
    yield* sendOutput(session, "stdout", result.stdout);
    yield* sendOutput(session, "stderr", result.stderr);
    yield* sendFrame(session, {
      code: Math.max(0, Math.min(255, result.exitCode)),
      truncated: result.truncated,
      type: "exit",
    });
    yield* session.finish;
  });

const sendPullSource = (
  session: BridgeSession,
  source: PullSource,
  manifestFrame: Uint8Array
) =>
  Effect.gen(function* () {
    yield* session.write(manifestFrame);

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

// Client-side-only tags (destination exists, remote limit) cannot occur in
// the server's pull path; they are mapped anyway so the compiler proves every
// pull error owns a bounded wire code.
const pullFailureCodes: Record<PullErrorTag, PullFailureCode> = {
  PullDestinationExistsError: "io",
  PullIntegrityError: "source-changed",
  PullIOError: "io",
  PullLimitError: "limit",
  PullNotFoundError: "not-found",
  PullPathError: "invalid-path",
  PullRemoteLimitError: "limit",
  PullSourceChangedError: "source-changed",
  PullSymlinkError: "symlink",
  ServedRootChangedError: "source-changed",
};

const pullFailureCode = (error: unknown): PullFailureCode | undefined => {
  if (typeof error !== "object" || error === null || !("_tag" in error)) {
    return;
  }

  const tag: unknown = error._tag;
  return typeof tag === "string" && Object.hasOwn(pullFailureCodes, tag)
    ? pullFailureCodes[tag as PullErrorTag]
    : undefined;
};

const sendPullFailure = (session: BridgeSession, code: PullFailureCode) =>
  sendFrame(session, { code, type: "pull-error" }).pipe(
    Effect.flatMap(() => session.finish)
  );

// Bounded independently because a reject is sent outside the run and pull
// deadlines; without it a peer that never acknowledges could pin an accept
// worker for the whole transport io deadline.
const rejectSendDeadline: Duration.Input = "5 seconds";

// A best-effort courtesy: the session still fails with its original error so
// the serve log records the tag even when the peer is already gone.
export const sendReject = (session: BridgeSession, code: RejectCode) =>
  sendFrame(session, { code, type: "reject" }).pipe(
    Effect.flatMap(() => session.finish),
    Effect.timeoutOrElse({
      duration: rejectSendDeadline,
      orElse: () => Effect.void,
    }),
    Effect.ignore
  );

export const handlePull = (
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
    const manifestFrame = encodeFrame({
      manifest: source.manifest,
      type: "manifest",
    });
    if (Result.isFailure(manifestFrame)) {
      return yield* manifestFrame.failure instanceof FrameTooLargeError
        ? sendPullFailure(session, "limit")
        : Effect.fail(manifestFrame.failure);
    }
    yield* sendPullSource(session, source, manifestFrame.success);
  }).pipe(
    Effect.catch((error) => {
      const code = pullFailureCode(error);
      return code === undefined
        ? Effect.fail(error)
        : sendPullFailure(session, code);
    })
  );
