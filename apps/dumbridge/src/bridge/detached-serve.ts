import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { uptime } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { type Duration, Effect, Result, Schema } from "effect";

const recordFileName = "detached-serve.json";
const startupDeadlineMs = 30_000;
const terminationDeadline: Duration.Input = "10 seconds";
const terminationPollInterval: Duration.Input = "50 millis";
const bridgeKeyLine = /^DUMBRIDGE_KEY=(\S+)\r?\n/m;
// The child prints its own key expiry; the detach parent forwards it so the
// user sees the same notice they would in the foreground.
const keyExpiryLine = /^The key expires at (\S+)\./m;
const cliStderrPrefix = /^dumbridge: /;
const maximumStartupStderrLength = 512;

// The record deliberately excludes the bridge key: the key must never land in
// any file, and process death alone revokes it.
const DetachedServeRecordSchema = Schema.Struct({
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  root: Schema.String,
  startedAtEpochMs: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0)
  ),
});

const DetachedServeRecordJson = Schema.fromJsonString(
  DetachedServeRecordSchema
);

type DetachedServeRecord = typeof DetachedServeRecordSchema.Type;

const DetachedServeReason = Schema.Literals([
  "already-running",
  "not-running",
  "startup-failed",
  "state-io",
  "state-overlap",
  "stop-timeout",
  "terminate-failed",
]);

export class DetachedServeError extends Schema.TaggedErrorClass<DetachedServeError>()(
  "DetachedServeError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
    reason: DetachedServeReason,
  }
) {}

export interface DetachedServeStartup {
  readonly expiresAtIso?: string;
  readonly key: string;
  readonly pid: number;
}

export interface DetachedSpawnRequest {
  readonly root: string;
  readonly ttl?: string;
}

type StopDetachedServeResult =
  | { readonly pid: number; readonly type: "stopped" }
  | { readonly type: "stale-record-removed" };

export interface ServeProcessControl {
  readonly bootTimeMs: Effect.Effect<number>;
  readonly isAlive: (pid: number) => Effect.Effect<boolean>;
  readonly spawnDetachedServe: (
    request: DetachedSpawnRequest
  ) => Effect.Effect<DetachedServeStartup, DetachedServeError>;
  readonly terminate: (pid: number) => Effect.Effect<void, DetachedServeError>;
}

const detachedServeError = (
  reason: typeof DetachedServeReason.Type,
  message: string,
  cause?: unknown
) => new DetachedServeError({ cause, message, reason });

const stateIOError = (cause: unknown) =>
  detachedServeError(
    "state-io",
    "The detached serve record could not be updated.",
    cause
  );

const recordPath = (stateDirectory: string) =>
  join(stateDirectory, recordFileName);

const hasCode = (cause: unknown, code: string) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === code;

type StoredRecord =
  | { readonly type: "absent" }
  | { readonly type: "unreadable" }
  | { readonly record: DetachedServeRecord; readonly type: "record" };

const readRecord = (
  stateDirectory: string
): Effect.Effect<StoredRecord, DetachedServeError> =>
  Effect.tryPromise({
    catch: (cause) => stateIOError(cause),
    try: async (): Promise<StoredRecord> => {
      let text: string;
      try {
        text = await readFile(recordPath(stateDirectory), "utf8");
      } catch (cause) {
        if (hasCode(cause, "ENOENT") || hasCode(cause, "ENOTDIR")) {
          return { type: "absent" };
        }
        throw cause;
      }
      const decoded = Schema.decodeUnknownResult(DetachedServeRecordJson)(text);
      return Result.isFailure(decoded)
        ? { type: "unreadable" }
        : { record: decoded.success, type: "record" };
    },
  });

// The exclusive create makes the record the single-winner lock for
// concurrent --detach invocations: the loser sees the record appear and must
// terminate its own child so no unmanaged serve survives the race.
class RecordTakenError {
  readonly _tag = "RecordTakenError";
}

const writeRecord = (stateDirectory: string, record: DetachedServeRecord) =>
  Effect.fromResult(Schema.encodeResult(DetachedServeRecordJson)(record)).pipe(
    Effect.mapError((cause) => stateIOError(cause)),
    Effect.flatMap((text) =>
      Effect.tryPromise({
        catch: (cause) =>
          cause instanceof RecordTakenError
            ? detachedServeError(
                "already-running",
                "A detached serve is already running. Stop it with dumbridge serve --stop."
              )
            : stateIOError(cause),
        try: async () => {
          await mkdir(stateDirectory, { recursive: true });
          try {
            await writeFile(recordPath(stateDirectory), `${text}\n`, {
              flag: "wx",
            });
          } catch (cause) {
            throw hasCode(cause, "EEXIST") ? new RecordTakenError() : cause;
          }
        },
      })
    )
  );

const removeRecord = (stateDirectory: string) =>
  Effect.tryPromise({
    catch: (cause) => stateIOError(cause),
    try: () => rm(recordPath(stateDirectory), { force: true }),
  });

const sameRecord = (left: DetachedServeRecord, right: DetachedServeRecord) =>
  left.pid === right.pid && left.startedAtEpochMs === right.startedAtEpochMs;

// Removal is conditional on the record still being the one this operation
// read: a concurrent --detach may have replaced it while this process was
// waiting, and deleting the newer record would orphan the serve it describes.
const removeRecordIfUnchanged = (stateDirectory: string, seen: StoredRecord) =>
  Effect.gen(function* () {
    const current = yield* readRecord(stateDirectory);
    const unchanged =
      (current.type === "unreadable" && seen.type === "unreadable") ||
      (current.type === "record" &&
        seen.type === "record" &&
        sameRecord(current.record, seen.record));
    if (unchanged) {
      yield* removeRecord(stateDirectory);
    }
  });

// The slack absorbs drift between the wall clock that stamped the record and
// the uptime-derived boot time. It errs toward treating a record as live:
// wrongly reporting a live serve as stale would leave its key valid while
// the user believes it was revoked.
const bootTimeSlackMs = 60_000;

// A record is stale when its process is gone, or when the machine rebooted
// after the record was written: a pid that reappears in a later boot belongs
// to some other process and must not be signaled.
const recordIsLive = (
  record: DetachedServeRecord,
  control: ServeProcessControl
) =>
  Effect.gen(function* () {
    const bootTimeMs = yield* control.bootTimeMs;
    if (record.startedAtEpochMs < bootTimeMs - bootTimeSlackMs) {
      return false;
    }
    return yield* control.isAlive(record.pid);
  });

// Symlinks are resolved from the deepest existing ancestor so a served root
// given as a link, or a state directory that does not exist yet, still
// compares by its canonical location, matching how ServedRoot canonicalizes
// the root it serves.
const canonicalizeExisting = async (path: string) => {
  let prefix = resolve(path);
  let suffix = "";
  for (;;) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Each attempt depends on the previous ancestor failing.
      const real = await realpath(prefix);
      return join(real, suffix);
    } catch {
      const parent = dirname(prefix);
      if (parent === prefix) {
        return resolve(path);
      }
      suffix = join(basename(prefix), suffix);
      prefix = parent;
    }
  }
};

// The local side never writes below the served root, so a record that would
// land inside the shared tree (for example serving the home directory over
// the default state directory) is refused instead of written.
const stateDirectoryInsideRoot = (root: string, stateDirectory: string) =>
  Effect.promise(async () => {
    const [canonicalRoot, canonicalState] = await Promise.all([
      canonicalizeExisting(root),
      canonicalizeExisting(stateDirectory),
    ]);
    const separation = relative(canonicalRoot, canonicalState);
    // Only an exact ".." path segment escapes the root; a sibling whose name
    // merely begins with dots (such as "..dumbridge") stays inside it.
    const escapesRoot =
      separation === ".." ||
      separation.startsWith(`..${sep}`) ||
      isAbsolute(separation);
    return !escapesRoot;
  });

export const detachServe = Effect.fn("DetachedServe.detach")(
  (options: {
    readonly control: ServeProcessControl;
    readonly root: string;
    readonly stateDirectory: string;
    readonly ttl?: string;
  }): Effect.Effect<DetachedServeStartup, DetachedServeError> =>
    Effect.gen(function* () {
      if (
        yield* stateDirectoryInsideRoot(options.root, options.stateDirectory)
      ) {
        return yield* detachedServeError(
          "state-overlap",
          "The detached serve record would land inside the served root. Set DUMBRIDGE_STATE_DIR to a directory outside it."
        );
      }
      const stored = yield* readRecord(options.stateDirectory);
      if (stored.type === "record") {
        const live = yield* recordIsLive(stored.record, options.control);
        if (live) {
          return yield* detachedServeError(
            "already-running",
            "A detached serve is already running. Stop it with dumbridge serve --stop."
          );
        }
      }
      if (stored.type !== "absent") {
        yield* removeRecordIfUnchanged(options.stateDirectory, stored);
      }

      const startup = yield* options.control.spawnDetachedServe({
        root: options.root,
        ...(options.ttl === undefined ? {} : { ttl: options.ttl }),
      });
      yield* writeRecord(options.stateDirectory, {
        pid: startup.pid,
        root: resolve(options.root),
        startedAtEpochMs: Date.now(),
      }).pipe(
        // An unrecorded detached serve could not be stopped later, so it must
        // not outlive a failed or lost record write.
        Effect.tapError(() =>
          options.control.terminate(startup.pid).pipe(Effect.ignore)
        )
      );
      return startup;
    })
);

const waitForExit = (pid: number, control: ServeProcessControl) => {
  const poll: Effect.Effect<void, DetachedServeError> = Effect.flatMap(
    control.isAlive(pid),
    (alive) =>
      alive
        ? Effect.sleep(terminationPollInterval).pipe(
            Effect.flatMap(() => Effect.suspend(() => poll))
          )
        : Effect.void
  );
  return poll.pipe(
    Effect.timeoutOrElse({
      duration: terminationDeadline,
      orElse: () =>
        detachedServeError(
          "stop-timeout",
          "The detached serve did not exit after being signaled."
        ),
    })
  );
};

export const stopDetachedServe = Effect.fn("DetachedServe.stop")(
  (options: {
    readonly control: ServeProcessControl;
    readonly stateDirectory: string;
  }): Effect.Effect<StopDetachedServeResult, DetachedServeError> =>
    Effect.gen(function* () {
      const stored = yield* readRecord(options.stateDirectory);
      if (stored.type === "absent") {
        return yield* detachedServeError(
          "not-running",
          "No detached serve is running."
        );
      }
      if (
        stored.type === "unreadable" ||
        !(yield* recordIsLive(stored.record, options.control))
      ) {
        yield* removeRecordIfUnchanged(options.stateDirectory, stored);
        return { type: "stale-record-removed" } as const;
      }

      yield* options.control.terminate(stored.record.pid);
      yield* waitForExit(stored.record.pid, options.control);
      yield* removeRecordIfUnchanged(options.stateDirectory, stored);
      return { pid: stored.record.pid, type: "stopped" } as const;
    })
);

const startupError = (stderr: string) => {
  // The child is this same CLI, so its stderr already carries the prefix.
  const detail = stderr.trim().replace(cliStderrPrefix, "");
  return detachedServeError(
    "startup-failed",
    detail.length > 0
      ? `The detached serve failed to start: ${detail.slice(0, maximumStartupStderrLength)}`
      : "The detached serve failed to start."
  );
};

// Spawns this CLI's own serve entry as a detached child, resolves once the
// child prints its bridge key, and then releases the stdio pipes so the child
// keeps running after this process exits. The key is handed to the caller in
// memory only.
const spawnDetachedServe = (request: DetachedSpawnRequest) =>
  Effect.tryPromise({
    catch: (cause) =>
      cause instanceof DetachedServeError ? cause : startupError(""),
    try: (signal) =>
      new Promise<DetachedServeStartup>((promiseResolve, promiseReject) => {
        const [, cliPath] = process.argv;
        if (cliPath === undefined) {
          promiseReject(startupError(""));
          return;
        }
        const serveArguments = [cliPath, "serve", request.root];
        if (request.ttl !== undefined) {
          serveArguments.push("--ttl", request.ttl);
        }
        const child = spawn(process.execPath, serveArguments, {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;

        const abandon = (error: DetachedServeError) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(deadline);
          child.kill("SIGTERM");
          promiseReject(error);
        };
        const deadline = setTimeout(() => {
          abandon(
            detachedServeError(
              "startup-failed",
              "The detached serve did not print a key in time."
            )
          );
        }, startupDeadlineMs);
        signal.addEventListener("abort", () => abandon(startupError("")), {
          once: true,
        });

        child.on("error", () => abandon(startupError("")));
        // "close" rather than "exit": it fires after the stdio pipes drain,
        // so a failed child's stderr is complete when the error is built.
        child.on("close", () => abandon(startupError(stderr)));
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          const match = bridgeKeyLine.exec(stdout);
          const { pid } = child;
          if (settled || match?.[1] === undefined || pid === undefined) {
            return;
          }
          settled = true;
          clearTimeout(deadline);
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          const expiresAtIso = keyExpiryLine.exec(stdout)?.[1];
          promiseResolve({
            key: match[1],
            pid,
            ...(expiresAtIso === undefined ? {} : { expiresAtIso }),
          });
        });
      }),
  });

export const hostServeProcessControl: ServeProcessControl = {
  bootTimeMs: Effect.sync(() => Date.now() - uptime() * 1000),
  isAlive: (pid) =>
    Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        // ESRCH means the process is gone. EPERM means the pid exists but is
        // not signalable by this user, so it cannot be a serve this user
        // spawned; treating it as dead lets the stale record be cleaned up.
        return false;
      }
    }),
  spawnDetachedServe,
  terminate: (pid) =>
    Effect.try({
      catch: (cause) =>
        detachedServeError(
          "terminate-failed",
          "The detached serve could not be signaled.",
          cause
        ),
      try: () => {
        try {
          process.kill(pid, "SIGTERM");
        } catch (cause) {
          if (!hasCode(cause, "ESRCH")) {
            throw cause;
          }
        }
      },
    }),
};
