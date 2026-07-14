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
  /** Cumulative bytes read per request; also bounds each individual host file. */
  readonly maxFileReadBytes: number;
  readonly maxLoopIterations: number;
  readonly maxOutputBytes: number;
  /** Cumulative bytes written into the request's throwaway overlay. */
  readonly maxOverlayBytes: number;
  /** Unique file, directory, and tombstone paths created in the overlay. */
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

const limitMessage = (limit: ShellLimit) =>
  `remote read shell ${limit} limit exceeded`;

const executionError = (cause: unknown) => {
  if (
    cause instanceof ServedRootChangedError ||
    cause instanceof ServedRootSourceChangedError
  ) {
    return cause;
  }
  if (cause instanceof ServedRootLimitSignal) {
    return new ShellLimitExceededError({
      limit: cause.limit,
      message: limitMessage(cause.limit),
    });
  }
  return new ShellExecutionError({
    message: "remote read shell execution failed",
  });
};

const makeExecute = (servedRoot: ServedRoot, limits: SafeShellLimits) =>
  Effect.fn("SafeShell.execute")((script: string) =>
    Effect.gen(function* () {
      if (encodedSize(script) > limits.maxScriptBytes) {
        return yield* new ShellLimitExceededError({
          limit: "script",
          message: limitMessage("script"),
        });
      }

      yield* servedRoot.verify();
      const view = yield* Effect.try({
        catch: executionError,
        try: () =>
          servedRoot.openReadView({
            maxFileReadBytes: limits.maxFileReadBytes,
            maxOverlayBytes: limits.maxOverlayBytes,
            maxOverlayEntries: limits.maxOverlayEntries,
          }),
      });
      yield* servedRoot.verify();
      const bash = yield* Effect.try({
        catch: executionError,
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
              message: limitMessage(view.limitExceeded),
            });
          }
          return executionError(cause);
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
          message: limitMessage(exceeded),
        });
      }

      // Appended after the output limit check so the note itself can never
      // trip the limit; the path shown is the agent's own normalized input.
      if (view.outsideRootPath !== undefined) {
        return {
          ...shellResult,
          stderr: `${shellResult.stderr}dumbridge: '${view.outsideRootPath}' is outside the served root; the served root is visible at ${view.workingDirectory}.\n`,
        };
      }

      return shellResult;
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
