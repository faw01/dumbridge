import {
  type ServedRoot,
  ServedRootChangedError,
  type ServedRootLimit,
  ServedRootLimitSignal,
  ServedRootSourceChangedError,
} from "@dumbridge/served-root";
import { Effect, Schema } from "effect";
import { Bash, type CommandName } from "just-bash";

const safeCommands = [
  "awk",
  "base64",
  "basename",
  "cat",
  "chmod",
  "comm",
  "cp",
  "cut",
  "diff",
  "dirname",
  "du",
  "echo",
  "egrep",
  "expr",
  "false",
  "fgrep",
  "file",
  "find",
  "fold",
  "grep",
  "head",
  "join",
  "jq",
  "ls",
  "md5sum",
  "mkdir",
  "mv",
  "nl",
  "od",
  "paste",
  "printf",
  "pwd",
  "readlink",
  "rev",
  "rg",
  "rm",
  "rmdir",
  "sed",
  "seq",
  "sha1sum",
  "sha256sum",
  "sort",
  "split",
  "stat",
  "strings",
  "tac",
  "tail",
  "tee",
  "touch",
  "tr",
  "tree",
  "true",
  "unexpand",
  "uniq",
  "wc",
  "xargs",
  "yq",
] satisfies readonly CommandName[];

export interface SafeShellLimits {
  readonly maxCommandCount: number;
  readonly maxFileReadBytes: number;
  readonly maxLoopIterations: number;
  readonly maxOutputBytes: number;
  readonly maxOverlayBytes: number;
  readonly maxOverlayEntries: number;
  readonly maxScriptBytes: number;
}

const defaultLimits: SafeShellLimits = {
  maxCommandCount: 2000,
  maxFileReadBytes: 4 * 1024 * 1024,
  maxLoopIterations: 1000,
  maxOutputBytes: 1024 * 1024,
  maxOverlayBytes: 4 * 1024 * 1024,
  maxOverlayEntries: 4096,
  maxScriptBytes: 64 * 1024,
};

const ShellLimit = Schema.Literals([
  "file-read",
  "overlay",
  "overlay-entries",
  "output",
  "script",
]);
type ShellLimit = typeof ShellLimit.Type;

class InvalidSafeShellLimitError extends Schema.TaggedErrorClass<InvalidSafeShellLimitError>()(
  "InvalidSafeShellLimitError",
  {
    limit: Schema.String,
    message: Schema.String,
  }
) {}

export class ShellLimitExceededError extends Schema.TaggedErrorClass<ShellLimitExceededError>()(
  "ShellLimitExceededError",
  {
    limit: ShellLimit,
    message: Schema.String,
  }
) {}

class ShellExecutionError extends Schema.TaggedErrorClass<ShellExecutionError>()(
  "ShellExecutionError",
  { message: Schema.String }
) {}

export interface ShellResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const encodedSize = (value: string) => new TextEncoder().encode(value).length;

const resolveLimits = (
  overrides: Partial<SafeShellLimits>
): Effect.Effect<SafeShellLimits, InvalidSafeShellLimitError> => {
  const limits = { ...defaultLimits, ...overrides };

  for (const [name, value] of Object.entries(limits)) {
    if (!(Number.isSafeInteger(value) && value > 0)) {
      return new InvalidSafeShellLimitError({
        limit: name,
        message: "safe shell limits must be positive safe integers",
      });
    }
  }

  return Effect.succeed(limits);
};

const classifyLimit = (
  result: ShellResult,
  limits: SafeShellLimits,
  filesystemLimit: ServedRootLimit | undefined
): ShellLimit | undefined => {
  if (filesystemLimit !== undefined) {
    return filesystemLimit;
  }
  if (
    encodedSize(result.stdout) + encodedSize(result.stderr) >
    limits.maxOutputBytes
  ) {
    return "output";
  }
};

const formatBytes = (bytes: number) => {
  const mebibyte = 1024 * 1024;
  if (bytes >= mebibyte && bytes % mebibyte === 0) {
    return `${bytes / mebibyte} MiB`;
  }
  if (bytes >= 1024 && bytes % 1024 === 0) {
    return `${bytes / 1024} KiB`;
  }
  return `${bytes} bytes`;
};

// Each message states the configured ceiling, whether it is per-file or
// cumulative, and how to recover, because the agent on the other side of the
// bridge sees only this one line.
const limitMessage = (limit: ShellLimit, limits: SafeShellLimits) => {
  const detail: Record<ShellLimit, string> = {
    "file-read": `one run may read at most ${formatBytes(limits.maxFileReadBytes)} in total across every file it opens; narrow the query to fewer files or a subdirectory`,
    output: `one run may return at most ${formatBytes(limits.maxOutputBytes)} of combined stdout and stderr; narrow the query or filter its output`,
    overlay: `one run may write at most ${formatBytes(limits.maxOverlayBytes)} into its throwaway overlay`,
    "overlay-entries": `one run may create at most ${limits.maxOverlayEntries} overlay entries`,
    script: `one script may be at most ${formatBytes(limits.maxScriptBytes)}; shorten the script`,
  };
  return `remote read shell ${limit} limit exceeded: ${detail[limit]}`;
};

const executionError = (cause: unknown, limits: SafeShellLimits) => {
  if (
    cause instanceof ServedRootChangedError ||
    cause instanceof ServedRootSourceChangedError
  ) {
    return cause;
  }
  if (cause instanceof ServedRootLimitSignal) {
    return new ShellLimitExceededError({
      limit: cause.limit,
      message: limitMessage(cause.limit, limits),
    });
  }
  return new ShellExecutionError({
    message: "remote read shell execution failed",
  });
};

const withOutsideRootNote = (
  shellResult: ShellResult,
  outsideRootPath: string | undefined,
  workingDirectory: string,
  maxOutputBytes: number
): ShellResult => {
  if (outsideRootPath === undefined) {
    return shellResult;
  }
  const separator =
    shellResult.stderr === "" || shellResult.stderr.endsWith("\n") ? "" : "\n";
  const note = `${separator}dumbridge: '${outsideRootPath}' is outside the served root; the served root is visible at ${workingDirectory}.\n`;
  const fits =
    encodedSize(shellResult.stdout) +
      encodedSize(shellResult.stderr) +
      encodedSize(note) <=
    maxOutputBytes;
  return fits
    ? { ...shellResult, stderr: `${shellResult.stderr}${note}` }
    : shellResult;
};

const makeExecute = (servedRoot: ServedRoot, limits: SafeShellLimits) =>
  Effect.fn("SafeShell.execute")((script: string) =>
    Effect.gen(function* () {
      if (encodedSize(script) > limits.maxScriptBytes) {
        return yield* new ShellLimitExceededError({
          limit: "script",
          message: limitMessage("script", limits),
        });
      }

      yield* servedRoot.verify();
      const view = yield* Effect.try({
        catch: (cause) => executionError(cause, limits),
        try: () =>
          servedRoot.openReadView({
            maxFileReadBytes: limits.maxFileReadBytes,
            maxOverlayBytes: limits.maxOverlayBytes,
            maxOverlayEntries: limits.maxOverlayEntries,
          }),
      });
      yield* servedRoot.verify();
      const bash = yield* Effect.try({
        catch: (cause) => executionError(cause, limits),
        try: () =>
          new Bash({
            commands: [...safeCommands],
            cwd: view.workingDirectory,
            // Just Bash's process-wide patches conflict with Effect's stack tracing.
            defenseInDepth: false,
            env: { HOME: view.workingDirectory },
            executionLimits: {
              maxArrayElements: 10_000,
              maxAwkIterations: limits.maxLoopIterations,
              maxBraceExpansionResults: 10_000,
              maxCallDepth: 50,
              maxCommandCount: limits.maxCommandCount,
              maxFileDescriptors: 128,
              maxGlobOperations: 50_000,
              maxHeredocSize: limits.maxScriptBytes,
              maxJqIterations: limits.maxLoopIterations,
              maxLoopIterations: limits.maxLoopIterations,
              maxOutputSize: limits.maxOutputBytes,
              maxSedIterations: limits.maxLoopIterations,
              maxSourceDepth: 20,
              maxStringLength: limits.maxOutputBytes,
              maxSubstitutionDepth: 20,
            },
            fs: view.fileSystem,
            javascript: false,
            python: false,
          }),
      });
      const result = yield* Effect.tryPromise({
        catch: (cause) => {
          if (view.sourceFailure !== undefined) {
            return view.sourceFailure;
          }
          if (view.limitExceeded !== undefined) {
            return new ShellLimitExceededError({
              limit: view.limitExceeded,
              message: limitMessage(view.limitExceeded, limits),
            });
          }
          return executionError(cause, limits);
        },
        try: async (signal) => {
          view.begin(signal);
          const execution = await bash.exec(script, { signal });
          return {
            execution,
            filesystemLimit: view.limitExceeded,
            sourceFailure: view.sourceFailure,
          };
        },
      });
      if (result.sourceFailure !== undefined) {
        return yield* result.sourceFailure;
      }
      yield* servedRoot.verify();
      const shellResult: ShellResult = {
        exitCode: result.execution.exitCode,
        stderr: result.execution.stderr,
        stdout: result.execution.stdout,
      };
      const exceeded = classifyLimit(
        shellResult,
        limits,
        result.filesystemLimit
      );

      if (exceeded !== undefined) {
        return yield* new ShellLimitExceededError({
          limit: exceeded,
          message: limitMessage(exceeded, limits),
        });
      }

      return withOutsideRootNote(
        shellResult,
        view.outsideRootPath,
        view.workingDirectory,
        limits.maxOutputBytes
      );
    })
  );

export class SafeShell {
  readonly execute: ReturnType<typeof makeExecute>;

  private constructor(execute: ReturnType<typeof makeExecute>) {
    this.execute = execute;
  }

  static readonly make = Effect.fn("SafeShell.make")(function* (
    servedRoot: ServedRoot,
    overrides: Partial<SafeShellLimits> = {}
  ) {
    const limits = yield* resolveLimits(overrides);
    return new SafeShell(makeExecute(servedRoot, limits));
  });
}
