import {
  type PullError,
  type PullFileEntry,
  PullIOError,
  PullNotFoundError,
  PullPathError,
  type PullRead,
  PullRemoteLimitError,
  PullSourceChangedError,
  PullSymlinkError,
} from "@dumbridge/pull-transfer";
import type { PullFailureCode, PullResponseEvent } from "@dumbridge/wire";
import { Effect, Option, Stream } from "effect";
import type { WireEventReader } from "./channel";

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

export const nextPullEvent = (
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

export const finishPullResponse = (
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

export const makeRemoteRead =
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
