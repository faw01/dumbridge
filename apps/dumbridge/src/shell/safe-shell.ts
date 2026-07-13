import { Buffer } from "node:buffer";
import { Effect, Schema } from "effect";
import { Bash, type CommandName, OverlayFs } from "just-bash";
import type { ServedRoot } from "../files/served-root";

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
  readonly maxOverlayBytes: number;
  readonly maxScriptBytes: number;
}

const defaultLimits: SafeShellLimits = {
  maxCommandCount: 2000,
  maxFileReadBytes: 4 * 1024 * 1024,
  maxLoopIterations: 1000,
  maxOutputBytes: 1024 * 1024,
  maxOverlayBytes: 4 * 1024 * 1024,
  maxScriptBytes: 64 * 1024,
};

const ShellLimit = Schema.Literals([
  "file-read",
  "overlay",
  "output",
  "script",
]);
export type ShellLimit = typeof ShellLimit.Type;

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

type FilesystemLimit = Extract<ShellLimit, "file-read" | "overlay">;

class FilesystemLimitSignal extends Error {
  readonly limit: FilesystemLimit;

  constructor(limit: FilesystemLimit) {
    super(`remote read shell ${limit} limit exceeded`);
    this.limit = limit;
  }
}

class RequestBudgetOverlayFs extends OverlayFs {
  limitExceeded: FilesystemLimit | undefined;

  private overlayBytes = 0;
  private readBytes = 0;
  private readonly maximumOverlayBytes: number;
  private readonly maximumReadBytes: number;
  private signal: AbortSignal | undefined;

  constructor(
    options: ConstructorParameters<typeof OverlayFs>[0],
    maximumReadBytes: number,
    maximumOverlayBytes: number
  ) {
    super(options);
    this.maximumReadBytes = maximumReadBytes;
    this.maximumOverlayBytes = maximumOverlayBytes;
  }

  begin(signal: AbortSignal) {
    this.signal = signal;
  }

  private assertActive() {
    this.signal?.throwIfAborted();
  }

  private async whileActive<A>(operation: () => Promise<A>): Promise<A> {
    this.assertActive();
    const result = await operation();
    this.assertActive();
    return result;
  }

  private reserve(kind: FilesystemLimit, bytes: number) {
    this.assertActive();
    const consumed = kind === "file-read" ? this.readBytes : this.overlayBytes;
    const maximum =
      kind === "file-read" ? this.maximumReadBytes : this.maximumOverlayBytes;
    if (bytes > maximum - consumed) {
      this.limitExceeded = kind;
      throw new FilesystemLimitSignal(kind);
    }
    if (kind === "file-read") {
      this.readBytes += bytes;
    } else {
      this.overlayBytes += bytes;
    }
  }

  override async readFileBuffer(
    ...args: Parameters<OverlayFs["readFileBuffer"]>
  ): ReturnType<OverlayFs["readFileBuffer"]> {
    this.assertActive();
    try {
      const content = await super.readFileBuffer(...args);
      this.reserve("file-read", content.byteLength);
      return content;
    } catch (error) {
      if (String(error).includes("EFBIG")) {
        this.limitExceeded = "file-read";
      }
      throw error;
    }
  }

  override async writeFile(
    ...args: Parameters<OverlayFs["writeFile"]>
  ): ReturnType<OverlayFs["writeFile"]> {
    this.reserve("overlay", fileContentSize(args[1], args[2]));
    await super.writeFile(...args);
    this.assertActive();
  }

  override async appendFile(
    ...args: Parameters<OverlayFs["appendFile"]>
  ): ReturnType<OverlayFs["appendFile"]> {
    this.reserve("overlay", fileContentSize(args[1], args[2]));
    await super.appendFile(...args);
    this.assertActive();
  }

  override stat(
    ...args: Parameters<OverlayFs["stat"]>
  ): ReturnType<OverlayFs["stat"]> {
    return this.whileActive(() => super.stat(...args));
  }

  override lstat(
    ...args: Parameters<OverlayFs["lstat"]>
  ): ReturnType<OverlayFs["lstat"]> {
    return this.whileActive(() => super.lstat(...args));
  }

  override readdir(
    ...args: Parameters<OverlayFs["readdir"]>
  ): ReturnType<OverlayFs["readdir"]> {
    return this.whileActive(() => super.readdir(...args));
  }

  override readdirWithFileTypes(
    ...args: Parameters<OverlayFs["readdirWithFileTypes"]>
  ): ReturnType<OverlayFs["readdirWithFileTypes"]> {
    return this.whileActive(() => super.readdirWithFileTypes(...args));
  }

  override async rm(
    ...args: Parameters<OverlayFs["rm"]>
  ): ReturnType<OverlayFs["rm"]> {
    await this.whileActive(() => super.rm(...args));
  }

  override async cp(
    ...args: Parameters<OverlayFs["cp"]>
  ): ReturnType<OverlayFs["cp"]> {
    await this.whileActive(() => super.cp(...args));
  }

  override getAllPaths(): ReturnType<OverlayFs["getAllPaths"]> {
    this.assertActive();
    const paths = super.getAllPaths();
    this.assertActive();
    return paths;
  }
}

const fileContentSize = (
  content: Parameters<OverlayFs["writeFile"]>[1],
  options: Parameters<OverlayFs["writeFile"]>[2]
) => {
  if (content instanceof Uint8Array) {
    return content.byteLength;
  }
  const encoding = typeof options === "string" ? options : options?.encoding;
  return Buffer.byteLength(content, encoding);
};

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
  filesystemLimit: FilesystemLimit | undefined
): ShellLimit | undefined => {
  if (filesystemLimit === "file-read") {
    return "file-read";
  }
  if (filesystemLimit === "overlay") {
    return "overlay";
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
  if (cause instanceof FilesystemLimitSignal) {
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
      const fs = yield* Effect.try({
        catch: executionError,
        try: () =>
          new RequestBudgetOverlayFs(
            {
              allowSymlinks: false,
              maxFileReadSize: limits.maxFileReadBytes,
              mountPoint: virtualRoot,
              root: servedRoot.path,
            },
            limits.maxFileReadBytes,
            limits.maxOverlayBytes
          ),
      });
      yield* servedRoot.verify();
      const bash = yield* Effect.try({
        catch: executionError,
        try: () =>
          new Bash({
            commands: [...safeCommands],
            cwd: virtualRoot,
            // Just Bash's process-wide patches conflict with Effect's stack tracing.
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
          }),
      });
      const result = yield* Effect.tryPromise({
        catch: executionError,
        try: async (signal) => {
          fs.begin(signal);
          const execution = await bash.exec(script, { signal });
          return {
            execution,
            filesystemLimit: fs.limitExceeded,
          };
        },
      });
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
