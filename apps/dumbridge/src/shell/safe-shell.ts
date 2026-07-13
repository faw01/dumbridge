import { realpathSync, statSync } from "node:fs";
import { Effect, Schema } from "effect";
import { Bash, type CommandName, OverlayFs } from "just-bash";

const virtualRoot = "/workspace";

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
  readonly maxScriptBytes: number;
}

const defaultLimits: SafeShellLimits = {
  maxCommandCount: 2000,
  maxFileReadBytes: 4 * 1024 * 1024,
  maxLoopIterations: 1000,
  maxOutputBytes: 1024 * 1024,
  maxScriptBytes: 64 * 1024,
};

const ShellLimit = Schema.Literals([
  "commands",
  "execution",
  "file-read",
  "loops",
  "output",
  "script",
]);
export type ShellLimit = typeof ShellLimit.Type;

export class InvalidServedRootError extends Schema.TaggedErrorClass<InvalidServedRootError>()(
  "InvalidServedRootError",
  { message: Schema.String }
) {}

export class InvalidSafeShellLimitError extends Schema.TaggedErrorClass<InvalidSafeShellLimitError>()(
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

export class ShellExecutionError extends Schema.TaggedErrorClass<ShellExecutionError>()(
  "ShellExecutionError",
  { message: Schema.String }
) {}

export interface ShellResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

class LimitAwareOverlayFs extends OverlayFs {
  fileReadLimitExceeded = false;

  override async readFileBuffer(
    ...args: Parameters<OverlayFs["readFileBuffer"]>
  ): ReturnType<OverlayFs["readFileBuffer"]> {
    try {
      return await super.readFileBuffer(...args);
    } catch (error) {
      if (String(error).includes("EFBIG")) {
        this.fileReadLimitExceeded = true;
      }
      throw error;
    }
  }
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
  fileReadLimitExceeded: boolean
): ShellLimit | undefined => {
  const stderr = result.stderr.toLowerCase();

  if (
    fileReadLimitExceeded ||
    stderr.includes("efbig") ||
    stderr.includes("file too large")
  ) {
    return "file-read";
  }
  if (
    encodedSize(result.stdout) + encodedSize(result.stderr) >
      limits.maxOutputBytes ||
    stderr.includes("output size exceeded")
  ) {
    return "output";
  }
  if (result.exitCode !== 126) {
    return;
  }
  if (stderr.includes("command")) {
    return "commands";
  }
  if (stderr.includes("loop") || stderr.includes("iteration")) {
    return "loops";
  }
  return "execution";
};

const limitMessage = (limit: ShellLimit) =>
  `remote read shell ${limit} limit exceeded`;

const makeExecute = (canonicalRoot: string, limits: SafeShellLimits) =>
  Effect.fn("SafeShell.execute")((script: string) =>
    Effect.gen(function* () {
      if (encodedSize(script) > limits.maxScriptBytes) {
        return yield* new ShellLimitExceededError({
          limit: "script",
          message: limitMessage("script"),
        });
      }

      const result = yield* Effect.tryPromise({
        catch: () =>
          new ShellExecutionError({
            message: "remote read shell execution failed",
          }),
        try: async (signal) => {
          const fs = new LimitAwareOverlayFs({
            allowSymlinks: false,
            maxFileReadSize: limits.maxFileReadBytes,
            mountPoint: virtualRoot,
            root: canonicalRoot,
          });
          const bash = new Bash({
            commands: [...safeCommands],
            cwd: virtualRoot,
            defenseInDepth: false,
            env: { HOME: virtualRoot },
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
            fs,
            javascript: false,
            python: false,
          });
          const execution = await bash.exec(script, { signal });
          return {
            execution,
            fileReadLimitExceeded: fs.fileReadLimitExceeded,
          };
        },
      });
      const shellResult: ShellResult = {
        exitCode: result.execution.exitCode,
        stderr: result.execution.stderr,
        stdout: result.execution.stdout,
      };
      const exceeded = classifyLimit(
        shellResult,
        limits,
        result.fileReadLimitExceeded
      );

      if (exceeded !== undefined) {
        return yield* new ShellLimitExceededError({
          limit: exceeded,
          message: limitMessage(exceeded),
        });
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
    servedRoot: string,
    overrides: Partial<SafeShellLimits> = {}
  ) {
    const limits = yield* resolveLimits(overrides);
    const canonicalRoot = yield* Effect.try({
      catch: () =>
        new InvalidServedRootError({
          message: "served root must be an existing directory",
        }),
      try: () => {
        const root = realpathSync(servedRoot);
        if (!statSync(root).isDirectory()) {
          throw new Error("served root is not a directory");
        }
        return root;
      },
    });

    return new SafeShell(makeExecute(canonicalRoot, limits));
  });
}
