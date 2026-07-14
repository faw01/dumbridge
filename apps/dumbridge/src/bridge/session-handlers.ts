import type { BridgeSession } from "@dumbridge/bridge-transport";
import { type PullSource, preparePull } from "@dumbridge/pull-transfer";
import {
  type SafeShell,
  ShellLimitExceededError,
  type ShellResult,
} from "@dumbridge/safe-shell";
import {
  type ServedRoot,
  ServedRootChangedError,
  ServedRootSourceChangedError,
} from "@dumbridge/served-root";
import {
  encodeFrame,
  FrameTooLargeError,
  type PullFailureCode,
  type PullResponseEvent,
  type RunResponseEvent,
} from "@dumbridge/wire";
import { Effect, Result, Schema, Stream } from "effect";
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

const executeShell = (shell: SafeShell, script: string) =>
  shell.execute(script).pipe(
    Effect.map((result) => ({ ...result, truncated: false })),
    Effect.catch((error) =>
      error instanceof ServedRootChangedError ||
      error instanceof ServedRootSourceChangedError
        ? Effect.fail(error)
        : Effect.succeed(
            failedShellResult(
              error instanceof ShellLimitExceededError
                ? error.message
                : "remote read shell failed"
            )
          )
    )
  );

export const handleRun = (
  session: BridgeSession,
  shell: SafeShell,
  script: string
) =>
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
