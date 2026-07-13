import { Buffer } from "node:buffer";
import { Effect, Schema } from "effect";
import { Bash, type CommandName, OverlayFs } from "just-bash";
import { type ServedRoot, ServedRootChangedError } from "../files/served-root";

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
  servedRootFailure: ServedRootChangedError | undefined;

  private overlayBytes = 0;
  private readBytes = 0;
  private readonly maximumOverlayBytes: number;
  private readonly maximumReadBytes: number;
  private readonly servedRoot: ServedRoot;
  private signal: AbortSignal | undefined;

  constructor(
    options: ConstructorParameters<typeof OverlayFs>[0],
    maximumReadBytes: number,
    maximumOverlayBytes: number,
    servedRoot: ServedRoot
  ) {
    super(options);
    this.maximumReadBytes = maximumReadBytes;
    this.maximumOverlayBytes = maximumOverlayBytes;
    this.servedRoot = servedRoot;
  }

  begin(signal: AbortSignal) {
    this.signal = signal;
  }

  private assertRequestOpen() {
    this.signal?.throwIfAborted();
    if (this.limitExceeded !== undefined) {
      throw new FilesystemLimitSignal(this.limitExceeded);
    }
  }

  private async whileRequestOpen<A>(operation: () => Promise<A>): Promise<A> {
    this.assertRequestOpen();
    const result = await operation();
    this.assertRequestOpen();
    return result;
  }

  private async whileGuarded<A>(operation: () => Promise<A>): Promise<A> {
    this.assertRequestOpen();
    try {
      return await this.servedRoot.guard(() =>
        this.whileRequestOpen(operation)
      );
    } catch (cause) {
      if (cause instanceof ServedRootChangedError) {
        this.servedRootFailure = cause;
      }
      throw cause;
    }
  }

  private whileGuardedSync<A>(operation: () => A): A {
    this.assertRequestOpen();
    try {
      return this.servedRoot.guardSync(() => {
        this.assertRequestOpen();
        const result = operation();
        this.assertRequestOpen();
        return result;
      });
    } catch (cause) {
      if (cause instanceof ServedRootChangedError) {
        this.servedRootFailure = cause;
      }
      throw cause;
    }
  }

  private reserve(kind: FilesystemLimit, bytes: number) {
    this.assertRequestOpen();
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
    try {
      return await this.whileGuarded(async () => {
        const stats = await super.stat(args[0]);
        const reservedBytes = stats.isFile ? stats.size : 0;
        this.reserve("file-read", reservedBytes);
        const content = await super.readFileBuffer(...args);
        if (content.byteLength > reservedBytes) {
          this.reserve("file-read", content.byteLength - reservedBytes);
        }
        return content;
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("EFBIG:")) {
        this.limitExceeded = "file-read";
      }
      throw error;
    }
  }

  override async writeFile(
    ...args: Parameters<OverlayFs["writeFile"]>
  ): ReturnType<OverlayFs["writeFile"]> {
    await this.whileGuarded(async () => {
      this.reserve("overlay", fileContentSize(args[1], args[2]));
      await super.writeFile(...args);
    });
  }

  override async appendFile(
    ...args: Parameters<OverlayFs["appendFile"]>
  ): ReturnType<OverlayFs["appendFile"]> {
    await this.whileGuarded(async () => {
      const appendedBytes = fileContentSize(args[1], args[2]);
      let existingBytes = 0;
      if (await super.exists(args[0])) {
        const stats = await super.stat(args[0]);
        existingBytes = stats.isFile ? stats.size : 0;
      }
      this.reserve("overlay", existingBytes + appendedBytes);
      await super.appendFile(...args);
    });
  }

  override exists(
    ...args: Parameters<OverlayFs["exists"]>
  ): ReturnType<OverlayFs["exists"]> {
    return this.whileGuarded(() => super.exists(...args));
  }

  override stat(
    ...args: Parameters<OverlayFs["stat"]>
  ): ReturnType<OverlayFs["stat"]> {
    return this.whileGuarded(() => super.stat(...args));
  }

  override lstat(
    ...args: Parameters<OverlayFs["lstat"]>
  ): ReturnType<OverlayFs["lstat"]> {
    return this.whileGuarded(() => super.lstat(...args));
  }

  override mkdir(
    ...args: Parameters<OverlayFs["mkdir"]>
  ): ReturnType<OverlayFs["mkdir"]> {
    return this.whileGuarded(() => super.mkdir(...args));
  }

  override readdir(
    ...args: Parameters<OverlayFs["readdir"]>
  ): ReturnType<OverlayFs["readdir"]> {
    return this.whileGuarded(() => super.readdir(...args));
  }

  override readdirWithFileTypes(
    ...args: Parameters<OverlayFs["readdirWithFileTypes"]>
  ): ReturnType<OverlayFs["readdirWithFileTypes"]> {
    return this.whileGuarded(() => super.readdirWithFileTypes(...args));
  }

  override rm(
    ...args: Parameters<OverlayFs["rm"]>
  ): ReturnType<OverlayFs["rm"]> {
    return this.whileGuarded(() => super.rm(...args));
  }

  override cp(
    ...args: Parameters<OverlayFs["cp"]>
  ): ReturnType<OverlayFs["cp"]> {
    return this.whileGuarded(() => super.cp(...args));
  }

  override mv(
    ...args: Parameters<OverlayFs["mv"]>
  ): ReturnType<OverlayFs["mv"]> {
    return this.whileGuarded(() => super.mv(...args));
  }

  override chmod(
    ...args: Parameters<OverlayFs["chmod"]>
  ): ReturnType<OverlayFs["chmod"]> {
    return this.whileGuarded(() => super.chmod(...args));
  }

  override symlink(
    ...args: Parameters<OverlayFs["symlink"]>
  ): ReturnType<OverlayFs["symlink"]> {
    return this.whileGuarded(() => super.symlink(...args));
  }

  override link(
    ...args: Parameters<OverlayFs["link"]>
  ): ReturnType<OverlayFs["link"]> {
    return this.whileGuarded(() => super.link(...args));
  }

  override readlink(
    ...args: Parameters<OverlayFs["readlink"]>
  ): ReturnType<OverlayFs["readlink"]> {
    return this.whileGuarded(() => super.readlink(...args));
  }

  override realpath(
    ...args: Parameters<OverlayFs["realpath"]>
  ): ReturnType<OverlayFs["realpath"]> {
    return this.whileGuarded(() => super.realpath(...args));
  }

  override utimes(
    ...args: Parameters<OverlayFs["utimes"]>
  ): ReturnType<OverlayFs["utimes"]> {
    return this.whileGuarded(() => super.utimes(...args));
  }

  override getAllPaths(): ReturnType<OverlayFs["getAllPaths"]> {
    return this.whileGuardedSync(() => super.getAllPaths());
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
  if (cause instanceof ServedRootChangedError) {
    return cause;
  }
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
            limits.maxOverlayBytes,
            servedRoot
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
            servedRootFailure: fs.servedRootFailure,
          };
        },
      });
      if (result.servedRootFailure !== undefined) {
        return yield* result.servedRootFailure;
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
