import { Buffer } from "node:buffer";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { join, posix } from "node:path";
import { Effect, Schema } from "effect";
import { type IFileSystem, OverlayFs } from "just-bash";

const virtualRoot = "/workspace";

interface ServedRootIdentity {
  readonly birthtimeMs: number;
  readonly device: number;
  readonly inode: number;
}

type PathKind = "directory" | "file" | "other" | "symlink";

type PathComponentSnapshot =
  | { readonly state: "missing" }
  | {
      readonly identity: ServedRootIdentity;
      readonly kind: PathKind;
      readonly state: "present";
    };

type VirtualPathSnapshot = readonly PathComponentSnapshot[] | undefined;

export type ServedRootLimit = "file-read" | "overlay";

export interface ServedRootReadLimits {
  readonly maxFileReadBytes: number;
  readonly maxOverlayBytes: number;
}

export interface ServedRootReadView {
  readonly begin: (signal: AbortSignal) => void;
  readonly fileSystem: IFileSystem;
  readonly limitExceeded: ServedRootLimit | undefined;
  readonly servedRootFailure: ServedRootChangedError | undefined;
  readonly workingDirectory: "/workspace";
}

export class InvalidServedRootError extends Schema.TaggedErrorClass<InvalidServedRootError>()(
  "InvalidServedRootError",
  { message: Schema.String }
) {}

export class ServedRootChangedError extends Schema.TaggedErrorClass<ServedRootChangedError>()(
  "ServedRootChangedError",
  { message: Schema.String }
) {}

export class ServedRootLimitSignal extends Error {
  readonly limit: ServedRootLimit;

  constructor(limit: ServedRootLimit) {
    super(`served root ${limit} limit exceeded`);
    this.limit = limit;
  }
}

const servedRootChanged = () =>
  new ServedRootChangedError({
    message: "served root changed after bridge start",
  });

const identityFrom = (stats: Stats): ServedRootIdentity => ({
  birthtimeMs: stats.birthtimeMs,
  device: stats.dev,
  inode: stats.ino,
});

const identitiesMatch = (
  expected: ServedRootIdentity,
  observed: ServedRootIdentity
) =>
  expected.birthtimeMs === observed.birthtimeMs &&
  expected.device === observed.device &&
  expected.inode === observed.inode;

const pathKindFrom = (stats: Stats): PathKind => {
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  return "other";
};

const pathComponentsMatch = (
  expected: PathComponentSnapshot,
  observed: PathComponentSnapshot
) => {
  if (expected.state === "missing" || observed.state === "missing") {
    return expected.state === observed.state;
  }
  return (
    expected.kind === observed.kind &&
    identitiesMatch(expected.identity, observed.identity)
  );
};

const pathSnapshotsMatch = (
  expected: VirtualPathSnapshot,
  observed: VirtualPathSnapshot
) => {
  if (expected === undefined || observed === undefined) {
    return expected === observed;
  }
  return (
    expected.length === observed.length &&
    expected.every((component, index) =>
      pathComponentsMatch(component, observed[index] as PathComponentSnapshot)
    )
  );
};

const inspectDirectory = (path: string) => {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("served root is not a directory");
  }
  return stats;
};

const isMissingPath = (cause: unknown) => {
  if (!(cause instanceof Error)) {
    return false;
  }
  const { code } = cause as NodeJS.ErrnoException;
  return code === "ENOENT" || code === "ENOTDIR";
};

const hostSegmentsFrom = (virtualPath: string) => {
  if (virtualPath.includes("\0") || virtualPath.includes("\\")) {
    throw new Error("EINVAL: invalid virtual path");
  }
  const normalized = posix.resolve("/", virtualPath);
  if (normalized === virtualRoot) {
    return [];
  }
  if (!normalized.startsWith(`${virtualRoot}/`)) {
    return;
  }
  return normalized.slice(virtualRoot.length + 1).split("/");
};

export class ServedRoot {
  readonly #hostPath: string;
  readonly #identity: ServedRootIdentity;

  private constructor(hostPath: string, identity: ServedRootIdentity) {
    this.#hostPath = hostPath;
    this.#identity = identity;
  }

  #assertCurrent() {
    try {
      const stats = inspectDirectory(this.#hostPath);
      const currentPath = realpathSync(this.#hostPath);
      if (
        currentPath !== this.#hostPath ||
        !identitiesMatch(this.#identity, identityFrom(stats))
      ) {
        throw new Error("served root identity changed");
      }
    } catch {
      // biome-ignore lint/style/useErrorCause: The cause may expose a host path.
      throw servedRootChanged();
    }
  }

  #snapshotVirtualPath(virtualPath: string): VirtualPathSnapshot {
    const segments = hostSegmentsFrom(virtualPath);
    if (segments === undefined) {
      return;
    }
    const snapshot: PathComponentSnapshot[] = [];
    let hostPath = this.#hostPath;
    for (const segment of segments) {
      hostPath = join(hostPath, segment);
      try {
        const stats = lstatSync(hostPath);
        snapshot.push({
          identity: identityFrom(stats),
          kind: pathKindFrom(stats),
          state: "present",
        });
        if (stats.isSymbolicLink()) {
          break;
        }
      } catch (cause) {
        if (isMissingPath(cause)) {
          snapshot.push({ state: "missing" });
          break;
        }
        throw servedRootChanged();
      }
    }
    return snapshot;
  }

  #snapshotVirtualPaths(paths: readonly string[]) {
    return [...new Set(paths)].map((path) => this.#snapshotVirtualPath(path));
  }

  #assertBoundaryUnchanged(
    paths: readonly string[],
    expected: readonly VirtualPathSnapshot[]
  ) {
    this.#assertCurrent();
    for (const [index, virtualPath] of paths.entries()) {
      if (
        !pathSnapshotsMatch(
          expected[index],
          this.#snapshotVirtualPath(virtualPath)
        )
      ) {
        throw servedRootChanged();
      }
    }
  }

  async #guardPaths<A>(
    paths: readonly string[],
    operation: () => Promise<A>
  ): Promise<A> {
    this.#assertCurrent();
    const guardedPaths = [...new Set(paths)];
    const expected = this.#snapshotVirtualPaths(guardedPaths);
    try {
      const result = await operation();
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      return result;
    } catch (cause) {
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      throw cause;
    }
  }

  #guardPathsSync<A>(paths: readonly string[], operation: () => A): A {
    this.#assertCurrent();
    const guardedPaths = [...new Set(paths)];
    const expected = this.#snapshotVirtualPaths(guardedPaths);
    try {
      const result = operation();
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      return result;
    } catch (cause) {
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      throw cause;
    }
  }

  #assertObservedPaths(paths: readonly string[]) {
    for (const virtualPath of paths) {
      const segments = hostSegmentsFrom(virtualPath);
      if (segments === undefined) {
        continue;
      }
      let hostPath = this.#hostPath;
      for (const [index, segment] of segments.entries()) {
        hostPath = join(hostPath, segment);
        try {
          const stats = lstatSync(hostPath);
          if (stats.isSymbolicLink() && index < segments.length - 1) {
            throw servedRootChanged();
          }
        } catch (cause) {
          if (cause instanceof ServedRootChangedError) {
            throw cause;
          }
          if (isMissingPath(cause)) {
            break;
          }
          throw servedRootChanged();
        }
      }
    }
  }

  static readonly make = Effect.fn("ServedRoot.make")((path: string) =>
    Effect.try({
      catch: () =>
        new InvalidServedRootError({
          message: "served root must be an existing directory",
        }),
      try: () => {
        const canonicalPath = realpathSync(path);
        const stats = inspectDirectory(canonicalPath);
        return new ServedRoot(canonicalPath, identityFrom(stats));
      },
    })
  );

  readonly verify = Effect.fn("ServedRoot.verify")(() =>
    Effect.try({
      catch: servedRootChanged,
      try: () => this.#assertCurrent(),
    })
  );

  readonly openReadView = (limits: ServedRootReadLimits) =>
    this.#guardPathsSync([], () => {
      const fileSystem = new RequestBudgetOverlayFs(
        this.#hostPath,
        limits,
        (paths, operation) => this.#guardPaths(paths, operation),
        (paths, operation) => this.#guardPathsSync(paths, operation),
        (paths) => this.#assertObservedPaths(paths)
      );
      return Object.freeze({
        begin: (signal: AbortSignal) => fileSystem.begin(signal),
        fileSystem: fileSystemFacade(fileSystem),
        get limitExceeded() {
          return fileSystem.limitExceeded;
        },
        get servedRootFailure() {
          return fileSystem.servedRootFailure;
        },
        workingDirectory: virtualRoot,
      } satisfies ServedRootReadView);
    });
}

type AsyncPathGuard = <A>(
  paths: readonly string[],
  operation: () => Promise<A>
) => Promise<A>;

type SyncPathGuard = <A>(paths: readonly string[], operation: () => A) => A;

class RequestBudgetOverlayFs extends OverlayFs {
  limitExceeded: ServedRootLimit | undefined;
  servedRootFailure: ServedRootChangedError | undefined;

  private overlayBytes = 0;
  private readBytes = 0;
  private readonly assertObservedPaths: (paths: readonly string[]) => void;
  private readonly guardPaths: AsyncPathGuard;
  private readonly guardPathsSync: SyncPathGuard;
  private readonly maximumOverlayBytes: number;
  private readonly maximumReadBytes: number;
  private signal: AbortSignal | undefined;

  constructor(
    hostRoot: string,
    limits: ServedRootReadLimits,
    guardPaths: AsyncPathGuard,
    guardPathsSync: SyncPathGuard,
    assertObservedPaths: (paths: readonly string[]) => void
  ) {
    super({
      allowSymlinks: false,
      maxFileReadSize: limits.maxFileReadBytes,
      mountPoint: virtualRoot,
      root: hostRoot,
    });
    this.maximumReadBytes = limits.maxFileReadBytes;
    this.maximumOverlayBytes = limits.maxOverlayBytes;
    this.guardPaths = guardPaths;
    this.guardPathsSync = guardPathsSync;
    this.assertObservedPaths = assertObservedPaths;
  }

  begin(signal: AbortSignal) {
    this.signal = signal;
  }

  private assertRequestOpen() {
    this.signal?.throwIfAborted();
    if (this.servedRootFailure !== undefined) {
      throw this.servedRootFailure;
    }
    if (this.limitExceeded !== undefined) {
      throw new ServedRootLimitSignal(this.limitExceeded);
    }
  }

  private async whileRequestOpen<A>(operation: () => Promise<A>): Promise<A> {
    this.assertRequestOpen();
    const result = await operation();
    this.assertRequestOpen();
    return result;
  }

  private async whileGuarded<A>(
    paths: readonly string[],
    operation: () => Promise<A>
  ): Promise<A> {
    this.assertRequestOpen();
    try {
      return await this.guardPaths(paths, () =>
        this.whileRequestOpen(operation)
      );
    } catch (cause) {
      if (cause instanceof ServedRootChangedError) {
        this.servedRootFailure = cause;
      }
      throw cause;
    }
  }

  private whileGuardedSync<A>(paths: readonly string[], operation: () => A): A {
    this.assertRequestOpen();
    try {
      return this.guardPathsSync(paths, () => {
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

  private reserve(kind: ServedRootLimit, bytes: number) {
    this.assertRequestOpen();
    const consumed = kind === "file-read" ? this.readBytes : this.overlayBytes;
    const maximum =
      kind === "file-read" ? this.maximumReadBytes : this.maximumOverlayBytes;
    if (bytes > maximum - consumed) {
      this.limitExceeded = kind;
      throw new ServedRootLimitSignal(kind);
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
      return await this.whileGuarded([args[0]], async () => {
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
    await this.whileGuarded([args[0]], async () => {
      this.reserve("overlay", fileContentSize(args[1], args[2]));
      await super.writeFile(...args);
    });
  }

  override async appendFile(
    ...args: Parameters<OverlayFs["appendFile"]>
  ): ReturnType<OverlayFs["appendFile"]> {
    await this.whileGuarded([args[0]], async () => {
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
    return this.whileGuarded([args[0]], () => super.exists(...args));
  }

  override stat(
    ...args: Parameters<OverlayFs["stat"]>
  ): ReturnType<OverlayFs["stat"]> {
    return this.whileGuarded([args[0]], () => super.stat(...args));
  }

  override lstat(
    ...args: Parameters<OverlayFs["lstat"]>
  ): ReturnType<OverlayFs["lstat"]> {
    return this.whileGuarded([args[0]], () => super.lstat(...args));
  }

  override mkdir(
    ...args: Parameters<OverlayFs["mkdir"]>
  ): ReturnType<OverlayFs["mkdir"]> {
    return this.whileGuarded([args[0]], () => super.mkdir(...args));
  }

  override readdir(
    ...args: Parameters<OverlayFs["readdir"]>
  ): ReturnType<OverlayFs["readdir"]> {
    return this.whileGuarded([args[0]], () => super.readdir(...args));
  }

  override readdirWithFileTypes(
    ...args: Parameters<OverlayFs["readdirWithFileTypes"]>
  ): ReturnType<OverlayFs["readdirWithFileTypes"]> {
    return this.whileGuarded([args[0]], () =>
      super.readdirWithFileTypes(...args)
    );
  }

  override rm(
    ...args: Parameters<OverlayFs["rm"]>
  ): ReturnType<OverlayFs["rm"]> {
    return this.whileGuarded([args[0]], () => super.rm(...args));
  }

  override cp(
    ...args: Parameters<OverlayFs["cp"]>
  ): ReturnType<OverlayFs["cp"]> {
    return this.whileGuarded([args[0], args[1]], () => super.cp(...args));
  }

  override mv(
    ...args: Parameters<OverlayFs["mv"]>
  ): ReturnType<OverlayFs["mv"]> {
    return this.whileGuarded([args[0], args[1]], () => super.mv(...args));
  }

  override async chmod(
    ...args: Parameters<OverlayFs["chmod"]>
  ): ReturnType<OverlayFs["chmod"]> {
    await this.whileGuarded([args[0]], async () => {
      const stats = await super.stat(args[0]);
      if (stats.isFile) {
        this.reserve("overlay", stats.size);
      }
      await super.chmod(...args);
    });
  }

  override symlink(
    ...args: Parameters<OverlayFs["symlink"]>
  ): ReturnType<OverlayFs["symlink"]> {
    return this.whileGuarded([args[1]], () => super.symlink(...args));
  }

  override link(
    ...args: Parameters<OverlayFs["link"]>
  ): ReturnType<OverlayFs["link"]> {
    return this.whileGuarded([args[0], args[1]], () => super.link(...args));
  }

  override readlink(
    ...args: Parameters<OverlayFs["readlink"]>
  ): ReturnType<OverlayFs["readlink"]> {
    return this.whileGuarded([args[0]], () => super.readlink(...args));
  }

  override realpath(
    ...args: Parameters<OverlayFs["realpath"]>
  ): ReturnType<OverlayFs["realpath"]> {
    return this.whileGuarded([args[0]], () => super.realpath(...args));
  }

  override async utimes(
    ...args: Parameters<OverlayFs["utimes"]>
  ): ReturnType<OverlayFs["utimes"]> {
    await this.whileGuarded([args[0]], async () => {
      const stats = await super.stat(args[0]);
      if (stats.isFile) {
        this.reserve("overlay", stats.size);
      }
      await super.utimes(...args);
    });
  }

  override getAllPaths(): ReturnType<OverlayFs["getAllPaths"]> {
    return this.whileGuardedSync([virtualRoot], () => {
      const paths = super.getAllPaths();
      this.assertObservedPaths(paths);
      return paths;
    });
  }
}

const fileSystemFacade = (fileSystem: RequestBudgetOverlayFs): IFileSystem => {
  const facade: IFileSystem = {
    appendFile: (path, content, options) =>
      fileSystem.appendFile(path, content, options),
    chmod: (path, mode) => fileSystem.chmod(path, mode),
    cp: (source, destination, options) =>
      fileSystem.cp(source, destination, options),
    exists: (path) => fileSystem.exists(path),
    getAllPaths: () => fileSystem.getAllPaths(),
    link: (existingPath, newPath) => fileSystem.link(existingPath, newPath),
    lstat: (path) => fileSystem.lstat(path),
    mkdir: (path, options) => fileSystem.mkdir(path, options),
    mv: (source, destination) => fileSystem.mv(source, destination),
    readdir: (path) => fileSystem.readdir(path),
    readdirWithFileTypes: (path) => fileSystem.readdirWithFileTypes(path),
    readFile: (path, options) => fileSystem.readFile(path, options),
    readFileBuffer: (path) => fileSystem.readFileBuffer(path),
    readFileBytes: (path) => fileSystem.readFileBytes(path),
    readlink: (path) => fileSystem.readlink(path),
    realpath: (path) => fileSystem.realpath(path),
    resolvePath: (base, path) => fileSystem.resolvePath(base, path),
    rm: (path, options) => fileSystem.rm(path, options),
    stat: (path) => fileSystem.stat(path),
    symlink: (target, linkPath) => fileSystem.symlink(target, linkPath),
    utimes: (path, atime, mtime) => fileSystem.utimes(path, atime, mtime),
    writeFile: (path, content, options) =>
      fileSystem.writeFile(path, content, options),
  };
  return Object.freeze(facade);
};

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
