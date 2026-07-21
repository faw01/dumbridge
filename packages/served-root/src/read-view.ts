import { Buffer } from "node:buffer";
import { promises as hostFileSystem, type Stats } from "node:fs";
import { join } from "node:path";
import { type IFileSystem, OverlayFs } from "just-bash";
import {
  ServedRootChangedError,
  type ServedRootLimit,
  ServedRootLimitSignal,
  ServedRootSourceChangedError,
} from "./errors";
import {
  type AsyncPathGuard,
  readOnlyNoFollowNonBlocking,
  type SyncPathGuard,
  virtualRoot,
} from "./host-paths";

const maxConcurrentHostReads = 32;

type HostFileHandle = Awaited<ReturnType<typeof hostFileSystem.open>>;

interface HostLeafIdentity {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
}

const safeHostReadCodes = [
  "EACCES",
  "EFTYPE",
  "EISDIR",
  "ELOOP",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
  "ESTALE",
];

const assertHostComponentKind = (stats: Stats, isLeaf: boolean) => {
  if (stats.isSymbolicLink()) {
    throw Object.assign(new Error("symbolic links are disabled"), {
      code: "ENOENT",
    });
  }
  if (!(isLeaf || stats.isDirectory())) {
    throw Object.assign(new Error("path component is not a directory"), {
      code: "ENOTDIR",
    });
  }
  if (isLeaf && !stats.isFile()) {
    throw Object.assign(new Error("unsupported file type"), {
      code: stats.isDirectory() ? "EISDIR" : "EFTYPE",
    });
  }
};

const safeHostReadError = (error: unknown, normalizedPath: string) => {
  const { code } = error as NodeJS.ErrnoException;
  const safeCode = code && safeHostReadCodes.includes(code) ? code : "EIO";
  return Object.assign(
    new Error(`${safeCode}: unable to read '${normalizedPath}'`),
    { code: safeCode }
  );
};

export interface ServedRootReadLimits {
  readonly maxFileReadBytes: number;
  readonly maxOverlayBytes: number;
  readonly maxOverlayEntries: number;
}

export interface ServedRootReadView {
  readonly begin: (signal: AbortSignal) => void;
  readonly fileSystem: IFileSystem;
  readonly limitExceeded: ServedRootLimit | undefined;
  readonly outsideRootPath: string | undefined;
  readonly sourceFailure:
    | ServedRootChangedError
    | ServedRootSourceChangedError
    | undefined;
  readonly workingDirectory: "/workspace";
}

export class RequestBudgetOverlayFs extends OverlayFs {
  limitExceeded: ServedRootLimit | undefined;
  sourceFailure:
    | ServedRootChangedError
    | ServedRootSourceChangedError
    | undefined;

  get outsideRootPath(): string | undefined {
    const [first] = this.outsideRootMisses;
    return first;
  }

  private readonly outsideRootMisses = new Set<string>();

  private activeHostReads = 0;
  private readonly chargedEntryPaths = new Set([virtualRoot]);
  private readonly hostRoot: string;
  private readonly maximumOverlayEntries: number;
  private readonly overlayFilePaths = new Set<string>();
  private readonly tombstonePaths = new Set<string>();
  private overlayEntries = 0;
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
    this.hostRoot = hostRoot;
    this.maximumReadBytes = limits.maxFileReadBytes;
    this.maximumOverlayBytes = limits.maxOverlayBytes;
    this.maximumOverlayEntries = limits.maxOverlayEntries;
    this.guardPaths = guardPaths;
    this.guardPathsSync = guardPathsSync;
    this.assertObservedPaths = assertObservedPaths;
  }

  begin(signal: AbortSignal) {
    this.signal = signal;
  }

  private assertRequestOpen() {
    this.signal?.throwIfAborted();
    if (this.sourceFailure !== undefined) {
      throw this.sourceFailure;
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
      if (
        cause instanceof ServedRootChangedError ||
        cause instanceof ServedRootSourceChangedError
      ) {
        this.sourceFailure = cause;
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
      if (
        cause instanceof ServedRootChangedError ||
        cause instanceof ServedRootSourceChangedError
      ) {
        this.sourceFailure = cause;
      }
      throw cause;
    }
  }

  private reserve(kind: ServedRootLimit, bytes: number) {
    this.assertRequestOpen();
    let consumed = this.overlayEntries;
    let maximum = this.maximumOverlayEntries;
    if (kind === "file-read") {
      consumed = this.readBytes;
      maximum = this.maximumReadBytes;
    } else if (kind === "overlay") {
      consumed = this.overlayBytes;
      maximum = this.maximumOverlayBytes;
    }
    if (bytes > maximum - consumed) {
      this.limitExceeded ??= kind;
      throw new ServedRootLimitSignal(this.limitExceeded);
    }
    if (kind === "file-read") {
      this.readBytes += bytes;
    } else if (kind === "overlay") {
      this.overlayBytes += bytes;
    } else {
      this.overlayEntries += bytes;
    }
  }

  private releaseRead(bytes: number) {
    this.readBytes -= bytes;
  }

  private acquireHostRead() {
    this.assertRequestOpen();
    if (this.activeHostReads >= maxConcurrentHostReads) {
      this.limitExceeded ??= "file-read";
      throw new ServedRootLimitSignal(this.limitExceeded);
    }
    this.activeHostReads += 1;
  }

  private normalize(path: string) {
    return super.resolvePath("/", path);
  }

  private recordOutsideRootMiss(path: string, error: unknown) {
    if (!isMissingRead(error)) {
      return;
    }
    const normalized = this.normalize(path);
    if (
      normalized !== virtualRoot &&
      !normalized.startsWith(`${virtualRoot}/`)
    ) {
      this.outsideRootMisses.add(normalized);
    }
  }

  private clearOutsideRootMiss(path: string) {
    this.outsideRootMisses.delete(this.normalize(path));
  }

  private async readGuarded<A>(
    path: string,
    operation: () => Promise<A>
  ): Promise<A> {
    try {
      return await this.whileGuarded([path], operation);
    } catch (error) {
      this.recordOutsideRootMiss(path, error);
      throw error;
    }
  }

  private chargeEntries(path: string, includeParents: boolean) {
    const normalized = this.normalize(path);
    const paths = [normalized];
    if (includeParents) {
      let parent = normalized;
      while (parent !== "/") {
        const separator = parent.lastIndexOf("/");
        parent = separator <= 0 ? "/" : parent.slice(0, separator);
        if (parent !== "/") {
          paths.push(parent);
        }
      }
    }
    const fresh = paths.filter((item) => !this.chargedEntryPaths.has(item));
    this.reserve("overlay-entries", fresh.length);
    for (const item of fresh) {
      this.chargedEntryPaths.add(item);
    }
  }

  private hostLocation(path: string) {
    const normalized = this.normalize(path);
    if (
      normalized !== virtualRoot &&
      !normalized.startsWith(`${virtualRoot}/`)
    ) {
      return;
    }
    const suffix = normalized.slice(virtualRoot.length);
    const relative = suffix.startsWith("/") ? suffix.slice(1) : suffix;
    const segments = relative === "" ? [] : relative.split("/");
    if (
      segments.some(
        (segment) => segment.includes("\\") || segment.includes("\0")
      )
    ) {
      return;
    }
    return { normalized, path: join(this.hostRoot, ...segments), segments };
  }

  private async lstatLeafIdentity(
    location: NonNullable<ReturnType<RequestBudgetOverlayFs["hostLocation"]>>
  ): Promise<HostLeafIdentity> {
    if (location.segments.length === 0) {
      throw Object.assign(new Error("served root is a directory"), {
        code: "EISDIR",
      });
    }
    let leafIdentity: HostLeafIdentity | undefined;
    let current = this.hostRoot;
    for (const [index, segment] of location.segments.entries()) {
      current = join(current, segment);
      // biome-ignore lint/performance/noAwaitInLoops: components must be validated in order and cancellation is checked per component
      const stats = await this.whileRequestOpen(() =>
        hostFileSystem.lstat(current)
      );
      const isLeaf = index === location.segments.length - 1;
      assertHostComponentKind(stats, isLeaf);
      if (isLeaf) {
        leafIdentity = {
          device: stats.dev,
          inode: stats.ino,
          size: stats.size,
        };
      }
    }
    if (leafIdentity === undefined) {
      throw Object.assign(new Error("file disappeared"), { code: "ENOENT" });
    }
    return leafIdentity;
  }

  private async verifyOpenedLeaf(
    handle: HostFileHandle,
    leaf: HostLeafIdentity
  ): Promise<number> {
    const stats = await this.whileRequestOpen(() => handle.stat());
    if (!stats.isFile()) {
      throw Object.assign(new Error("unsupported file type"), {
        code: "EFTYPE",
      });
    }
    if (stats.dev !== leaf.device || stats.ino !== leaf.inode) {
      throw Object.assign(new Error("file identity changed"), {
        code: "ESTALE",
      });
    }
    return stats.size;
  }

  private retrueReadReservation(reserved: number, actual: number): number {
    if (actual > reserved) {
      this.reserve("file-read", actual - reserved);
    } else if (actual < reserved) {
      this.releaseRead(reserved - actual);
    }
    return actual;
  }

  private async readVerifiedContent(
    handle: HostFileHandle,
    size: number,
    normalizedPath: string
  ): Promise<Uint8Array> {
    const content = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < content.byteLength) {
      const length = Math.min(64 * 1024, content.byteLength - offset);
      // biome-ignore lint/performance/noAwaitInLoops: bounded chunks provide cooperative cancellation
      const result = await this.whileRequestOpen(() =>
        handle.read(content, offset, length, offset)
      );
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }

    if (offset === content.byteLength) {
      const probe = Buffer.allocUnsafe(1);
      const result = await this.whileRequestOpen(() =>
        handle.read(probe, 0, 1, offset)
      );
      if (result.bytesRead > 0) {
        this.limitExceeded ??= "file-read";
        throw new ServedRootLimitSignal(this.limitExceeded);
      }
    }

    if (offset < size) {
      throw new ServedRootSourceChangedError({
        path: normalizedPath,
      });
    }
    return content;
  }

  private async readHostFile(
    location: NonNullable<ReturnType<RequestBudgetOverlayFs["hostLocation"]>>
  ): Promise<Uint8Array> {
    let handle: HostFileHandle | undefined;
    let hasHostReadSlot = false;
    let reserved = 0;
    try {
      const leaf = await this.lstatLeafIdentity(location);
      this.reserve("file-read", leaf.size);
      reserved = leaf.size;
      this.acquireHostRead();
      hasHostReadSlot = true;
      handle = await this.whileRequestOpen(() =>
        hostFileSystem.open(location.path, readOnlyNoFollowNonBlocking)
      );
      const size = await this.verifyOpenedLeaf(handle, leaf);
      reserved = this.retrueReadReservation(reserved, size);
      return await this.readVerifiedContent(handle, size, location.normalized);
    } catch (error) {
      if (error instanceof ServedRootLimitSignal) {
        throw error;
      }
      this.signal?.throwIfAborted();
      if (reserved > 0) {
        this.releaseRead(reserved);
      }
      if (error instanceof ServedRootSourceChangedError) {
        throw error;
      }
      throw safeHostReadError(error, location.normalized);
    } finally {
      await handle?.close().catch(() => undefined);
      if (hasHostReadSlot) {
        this.activeHostReads -= 1;
      }
    }
  }

  private async readOverlayFile(
    ...args: Parameters<OverlayFs["readFileBuffer"]>
  ): ReturnType<OverlayFs["readFileBuffer"]> {
    let reservedBytes = 0;
    try {
      const stats = await super.lstat(args[0]);
      if (!stats.isFile) {
        throw Object.assign(new Error("unsupported file type"), {
          code: stats.isDirectory ? "EISDIR" : "EFTYPE",
        });
      }
      reservedBytes = stats.size;
      this.reserve("file-read", reservedBytes);
      const content = await super.readFileBuffer(...args);
      this.retrueReadReservation(reservedBytes, content.byteLength);
      return content;
    } catch (error) {
      if (!(error instanceof ServedRootLimitSignal) && reservedBytes > 0) {
        this.releaseRead(reservedBytes);
      }
      throw error;
    }
  }

  override async readFileBuffer(
    ...args: Parameters<OverlayFs["readFileBuffer"]>
  ): ReturnType<OverlayFs["readFileBuffer"]> {
    try {
      return await this.readGuarded(args[0], () => {
        const normalized = this.normalize(args[0]);
        const location = this.hostLocation(normalized);
        const isServedPath =
          normalized === virtualRoot ||
          normalized.startsWith(`${virtualRoot}/`);
        if (isServedPath && location === undefined) {
          throw Object.assign(
            new Error(`ENOENT: unable to read '${normalized}'`),
            { code: "ENOENT" }
          );
        }
        if (
          location !== undefined &&
          !this.overlayFilePaths.has(normalized) &&
          !this.tombstonePaths.has(normalized)
        ) {
          return this.readHostFile(location);
        }
        return this.readOverlayFile(...args);
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
      this.chargeEntries(args[0], true);
      this.reserve("overlay", fileContentSize(args[1], args[2]));
      await super.writeFile(...args);
      const normalized = this.normalize(args[0]);
      this.overlayFilePaths.add(normalized);
      this.tombstonePaths.delete(normalized);
      this.clearOutsideRootMiss(normalized);
    });
  }

  override async appendFile(
    ...args: Parameters<OverlayFs["appendFile"]>
  ): ReturnType<OverlayFs["appendFile"]> {
    await this.whileGuarded([args[0]], async () => {
      this.chargeEntries(args[0], true);
      const appendedBytes = fileContentSize(args[1], args[2]);
      const normalized = this.normalize(args[0]);
      let materializedBytes = 0;
      if (
        !(
          this.overlayFilePaths.has(normalized) ||
          this.tombstonePaths.has(normalized)
        )
      ) {
        try {
          const stats = await super.stat(args[0]);
          materializedBytes = stats.isFile ? stats.size : 0;
        } catch {
          materializedBytes = 0;
        }
      }
      this.reserve("overlay", materializedBytes + appendedBytes);
      await super.appendFile(...args);
      this.overlayFilePaths.add(normalized);
      this.tombstonePaths.delete(normalized);
      this.clearOutsideRootMiss(normalized);
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
    return this.readGuarded(args[0], () => super.stat(...args));
  }

  override lstat(
    ...args: Parameters<OverlayFs["lstat"]>
  ): ReturnType<OverlayFs["lstat"]> {
    return this.readGuarded(args[0], () => super.lstat(...args));
  }

  override async mkdir(
    ...args: Parameters<OverlayFs["mkdir"]>
  ): ReturnType<OverlayFs["mkdir"]> {
    await this.whileGuarded([args[0]], async () => {
      this.chargeEntries(args[0], true);
      await super.mkdir(...args);
      this.tombstonePaths.delete(this.normalize(args[0]));
      this.clearOutsideRootMiss(args[0]);
    });
  }

  override readdir(
    ...args: Parameters<OverlayFs["readdir"]>
  ): ReturnType<OverlayFs["readdir"]> {
    return this.readGuarded(args[0], () => super.readdir(...args));
  }

  override readdirWithFileTypes(
    ...args: Parameters<OverlayFs["readdirWithFileTypes"]>
  ): ReturnType<OverlayFs["readdirWithFileTypes"]> {
    return this.readGuarded(args[0], () => super.readdirWithFileTypes(...args));
  }

  override async rm(
    ...args: Parameters<OverlayFs["rm"]>
  ): ReturnType<OverlayFs["rm"]> {
    await this.whileGuarded([args[0]], async () => {
      this.chargeEntries(args[0], false);
      await super.rm(...args);
      const normalized = this.normalize(args[0]);
      this.overlayFilePaths.delete(normalized);
      this.tombstonePaths.add(normalized);
    });
  }

  override cp(
    ...args: Parameters<OverlayFs["cp"]>
  ): ReturnType<OverlayFs["cp"]> {
    return this.whileGuarded([args[0], args[1]], async () => {
      await super.cp(...args);
      this.clearOutsideRootMiss(args[1]);
    });
  }

  override mv(
    ...args: Parameters<OverlayFs["mv"]>
  ): ReturnType<OverlayFs["mv"]> {
    return this.whileGuarded([args[0], args[1]], async () => {
      await super.mv(...args);
      this.clearOutsideRootMiss(args[1]);
    });
  }

  override async chmod(
    ...args: Parameters<OverlayFs["chmod"]>
  ): ReturnType<OverlayFs["chmod"]> {
    await this.whileGuarded([args[0]], async () => {
      const stats = await super.stat(args[0]);
      const normalized = this.normalize(args[0]);
      this.chargeEntries(normalized, false);
      if (stats.isFile && !this.overlayFilePaths.has(normalized)) {
        this.reserve("overlay", stats.size);
      }
      await super.chmod(...args);
      if (stats.isFile) {
        this.overlayFilePaths.add(normalized);
      }
    });
  }

  override async symlink(
    ...args: Parameters<OverlayFs["symlink"]>
  ): ReturnType<OverlayFs["symlink"]> {
    await this.whileGuarded([args[1]], async () => {
      this.chargeEntries(args[1], true);
      await super.symlink(...args);
      this.overlayFilePaths.add(this.normalize(args[1]));
      this.clearOutsideRootMiss(args[1]);
    });
  }

  override async link(
    ...args: Parameters<OverlayFs["link"]>
  ): ReturnType<OverlayFs["link"]> {
    await this.whileGuarded([args[0], args[1]], async () => {
      const stats = await super.stat(args[0]);
      this.chargeEntries(args[1], true);
      if (stats.isFile) {
        this.reserve("overlay", stats.size);
      }
      await super.link(...args);
      this.overlayFilePaths.add(this.normalize(args[1]));
      this.clearOutsideRootMiss(args[1]);
    });
  }

  override readlink(
    ...args: Parameters<OverlayFs["readlink"]>
  ): ReturnType<OverlayFs["readlink"]> {
    return this.readGuarded(args[0], () => super.readlink(...args));
  }

  override realpath(
    ...args: Parameters<OverlayFs["realpath"]>
  ): ReturnType<OverlayFs["realpath"]> {
    return this.readGuarded(args[0], () => super.realpath(...args));
  }

  override async utimes(
    ...args: Parameters<OverlayFs["utimes"]>
  ): ReturnType<OverlayFs["utimes"]> {
    await this.whileGuarded([args[0]], async () => {
      const stats = await super.stat(args[0]);
      const normalized = this.normalize(args[0]);
      this.chargeEntries(normalized, false);
      if (stats.isFile && !this.overlayFilePaths.has(normalized)) {
        this.reserve("overlay", stats.size);
      }
      await super.utimes(...args);
      if (stats.isFile) {
        this.overlayFilePaths.add(normalized);
      }
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

export const fileSystemFacade = (
  fileSystem: RequestBudgetOverlayFs
): IFileSystem => {
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

const isMissingRead = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }
  const { code } = error as NodeJS.ErrnoException;
  return (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    error.message.startsWith("ENOENT") ||
    error.message.startsWith("ENOTDIR")
  );
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
