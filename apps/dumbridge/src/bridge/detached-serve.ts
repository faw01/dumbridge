import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
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

// One record file per served root: the name hashes the resolved root so
// serves of different roots coexist while a duplicate root collides on the
// same exclusive-create target.
const recordFileName = (root: string) =>
  `detached-serve-${createHash("sha256").update(resolve(root)).digest("hex")}.json`;
const recordFilePattern = /^detached-serve-[0-9a-f]{64}\.json$/;
const startupDeadlineMs = 30_000;
const terminationDeadline: Duration.Input = "10 seconds";
const terminationPollInterval: Duration.Input = "50 millis";
const bridgeKeyLine = /^DUMBRIDGE_KEY=(\S+)\r?\n/m;
const keyExpiryLine = /^The key expires at (\S+)\./m;
const cliStderrPrefix = /^dumbridge: /;
const maximumStartupStderrLength = 512;

// The record deliberately excludes the bridge key: the key must never land in
// any file, and process death alone revokes it. The key's expiry deadline is
// not the key and is persisted for status surfaces.
const DetachedServeRecordSchema = Schema.Struct({
  expiresAtEpochMs: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
  ),
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

export type DetachedServeRecord = typeof DetachedServeRecordSchema.Type;

const DetachedServeReason = Schema.Literals([
  "already-running",
  "multiple-running",
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

export type ServeReachability = "direct-only" | "relay-only";

export interface DetachedSpawnRequest {
  readonly reachability?: ServeReachability;
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

const byCodeUnit = (left: string, right: string) =>
  left < right ? -1 : Number(left > right);

const hasCode = (cause: unknown, code: string) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === code;

type StoredRecord =
  | { readonly type: "absent" }
  | { readonly type: "unreadable" }
  | { readonly record: DetachedServeRecord; readonly type: "record" };

interface StoredRecordEntry {
  readonly fileName: string;
  readonly stored: Exclude<StoredRecord, { readonly type: "absent" }>;
}

const readStoredRecord = async (path: string): Promise<StoredRecord> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
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
};

const readRecord = (
  stateDirectory: string,
  fileName: string
): Effect.Effect<StoredRecord, DetachedServeError> =>
  Effect.tryPromise({
    catch: (cause) => stateIOError(cause),
    try: () => readStoredRecord(join(stateDirectory, fileName)),
  });

const isPresent = (entry: {
  readonly fileName: string;
  readonly stored: StoredRecord;
}): entry is StoredRecordEntry => entry.stored.type !== "absent";

const readRecordEntries = (
  stateDirectory: string
): Effect.Effect<readonly StoredRecordEntry[], DetachedServeError> =>
  Effect.tryPromise({
    catch: (cause) => stateIOError(cause),
    try: async () => {
      let names: readonly string[];
      try {
        names = await readdir(stateDirectory);
      } catch (cause) {
        if (hasCode(cause, "ENOENT") || hasCode(cause, "ENOTDIR")) {
          return [];
        }
        throw cause;
      }
      const entries = await Promise.all(
        names
          .filter((name) => recordFilePattern.test(name))
          .sort(byCodeUnit)
          .map(async (fileName) => ({
            fileName,
            stored: await readStoredRecord(join(stateDirectory, fileName)),
          }))
      );
      // A record can vanish between the directory scan and its read when a
      // concurrent stop reclaims it; a vanished record is simply not listed.
      return entries.filter(isPresent);
    },
  });

class RecordTakenError {
  readonly _tag = "RecordTakenError";
}

const alreadyServingError = (root: string) =>
  detachedServeError(
    "already-running",
    `A detached serve is already running for ${root}. Stop it with dumbridge serve --stop ${root}.`
  );

const writeRecord = (stateDirectory: string, record: DetachedServeRecord) =>
  Effect.fromResult(Schema.encodeResult(DetachedServeRecordJson)(record)).pipe(
    Effect.mapError((cause) => stateIOError(cause)),
    Effect.flatMap((text) =>
      Effect.tryPromise({
        catch: (cause) =>
          cause instanceof RecordTakenError
            ? alreadyServingError(record.root)
            : stateIOError(cause),
        try: async () => {
          await mkdir(stateDirectory, { recursive: true });
          try {
            await writeFile(
              join(stateDirectory, recordFileName(record.root)),
              `${text}\n`,
              { flag: "wx" }
            );
          } catch (cause) {
            throw hasCode(cause, "EEXIST") ? new RecordTakenError() : cause;
          }
        },
      })
    )
  );

const removeRecord = (stateDirectory: string, fileName: string) =>
  Effect.tryPromise({
    catch: (cause) => stateIOError(cause),
    try: () => rm(join(stateDirectory, fileName), { force: true }),
  });

const sameRecord = (left: DetachedServeRecord, right: DetachedServeRecord) =>
  left.pid === right.pid && left.startedAtEpochMs === right.startedAtEpochMs;

const removeRecordIfUnchanged = (
  stateDirectory: string,
  fileName: string,
  seen: StoredRecord
) =>
  Effect.gen(function* () {
    const current = yield* readRecord(stateDirectory, fileName);
    const unchanged =
      (current.type === "unreadable" && seen.type === "unreadable") ||
      (current.type === "record" &&
        seen.type === "record" &&
        sameRecord(current.record, seen.record));
    if (unchanged) {
      yield* removeRecord(stateDirectory, fileName);
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

const stateDirectoryInsideRoot = (root: string, stateDirectory: string) =>
  Effect.promise(async () => {
    const [canonicalRoot, canonicalState] = await Promise.all([
      canonicalizeExisting(root),
      canonicalizeExisting(stateDirectory),
    ]);
    const separation = relative(canonicalRoot, canonicalState);
    const escapesRoot =
      separation === ".." ||
      separation.startsWith(`..${sep}`) ||
      isAbsolute(separation);
    return !escapesRoot;
  });

export const detachServe = Effect.fn("DetachedServe.detach")(
  (options: {
    readonly control: ServeProcessControl;
    readonly reachability?: ServeReachability;
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
      const root = resolve(options.root);
      const fileName = recordFileName(root);
      const stored = yield* readRecord(options.stateDirectory, fileName);
      if (stored.type === "record") {
        const live = yield* recordIsLive(stored.record, options.control);
        if (live) {
          return yield* alreadyServingError(root);
        }
      }
      if (stored.type !== "absent") {
        yield* removeRecordIfUnchanged(
          options.stateDirectory,
          fileName,
          stored
        );
      }

      const startup = yield* options.control.spawnDetachedServe({
        root: options.root,
        ...(options.reachability === undefined
          ? {}
          : { reachability: options.reachability }),
        ...(options.ttl === undefined ? {} : { ttl: options.ttl }),
      });
      const expiresAtEpochMs =
        startup.expiresAtIso === undefined
          ? Number.NaN
          : Date.parse(startup.expiresAtIso);
      yield* writeRecord(options.stateDirectory, {
        ...(Number.isFinite(expiresAtEpochMs) ? { expiresAtEpochMs } : {}),
        pid: startup.pid,
        root,
        startedAtEpochMs: Date.now(),
      }).pipe(
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

const recordEntriesForStop = (
  stateDirectory: string,
  root: string | undefined
): Effect.Effect<readonly StoredRecordEntry[], DetachedServeError> => {
  if (root === undefined) {
    return readRecordEntries(stateDirectory);
  }
  const fileName = recordFileName(root);
  return Effect.map(readRecord(stateDirectory, fileName), (stored) =>
    stored.type === "absent" ? [] : [{ fileName, stored }]
  );
};

interface LiveRecordEntry {
  readonly fileName: string;
  readonly record: DetachedServeRecord;
  readonly stored: StoredRecord;
}

export const stopDetachedServe = Effect.fn("DetachedServe.stop")(
  (options: {
    readonly control: ServeProcessControl;
    readonly root?: string;
    readonly stateDirectory: string;
  }): Effect.Effect<StopDetachedServeResult, DetachedServeError> =>
    Effect.gen(function* () {
      const entries = yield* recordEntriesForStop(
        options.stateDirectory,
        options.root
      );
      if (entries.length === 0) {
        return yield* detachedServeError(
          "not-running",
          options.root === undefined
            ? "No detached serve is running."
            : `No detached serve is running for ${resolve(options.root)}.`
        );
      }

      const live: LiveRecordEntry[] = [];
      for (const { fileName, stored } of entries) {
        if (
          stored.type === "record" &&
          (yield* recordIsLive(stored.record, options.control))
        ) {
          live.push({ fileName, record: stored.record, stored });
          continue;
        }
        yield* removeRecordIfUnchanged(
          options.stateDirectory,
          fileName,
          stored
        );
      }

      const [only, ...others] = live;
      if (only === undefined) {
        return { type: "stale-record-removed" } as const;
      }
      if (others.length > 0) {
        const roots = live.map((entry) => entry.record.root).sort(byCodeUnit);
        return yield* detachedServeError(
          "multiple-running",
          `Multiple detached serves are running (${roots.join(", ")}). Stop one with dumbridge serve --stop <root>.`
        );
      }

      yield* options.control.terminate(only.record.pid);
      yield* waitForExit(only.record.pid, options.control);
      yield* removeRecordIfUnchanged(
        options.stateDirectory,
        only.fileName,
        only.stored
      );
      return { pid: only.record.pid, type: "stopped" } as const;
    })
);

// The status surface (serve --status) is expected to consume this listing.
export const listDetachedServes = Effect.fn("DetachedServe.list")(
  (options: {
    readonly control: ServeProcessControl;
    readonly stateDirectory: string;
  }): Effect.Effect<readonly DetachedServeRecord[], DetachedServeError> =>
    Effect.gen(function* () {
      const entries = yield* readRecordEntries(options.stateDirectory);
      const live: DetachedServeRecord[] = [];
      for (const { stored } of entries) {
        if (
          stored.type === "record" &&
          (yield* recordIsLive(stored.record, options.control))
        ) {
          live.push(stored.record);
        }
      }
      return live.sort((left, right) => byCodeUnit(left.root, right.root));
    })
);

const startupError = (stderr: string) => {
  const detail = stderr.trim().replace(cliStderrPrefix, "");
  return detachedServeError(
    "startup-failed",
    detail.length > 0
      ? `The detached serve failed to start: ${detail.slice(0, maximumStartupStderrLength)}`
      : "The detached serve failed to start."
  );
};

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
        if (request.reachability !== undefined) {
          serveArguments.push(`--${request.reachability}`);
        }
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
