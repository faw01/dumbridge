import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep, win32 } from "node:path";
import { Effect, Schema } from "effect";

const digestPattern = /^[0-9a-f]{64}$/;
const windowsDrivePattern = /^[a-z]:/i;
// biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags compose as a bitmask.
const readOnlyNoFollow = constants.O_RDONLY | constants.O_NOFOLLOW;

const FileEntrySchema = Schema.Struct({
  digest: Schema.String,
  kind: Schema.Literal("file"),
  path: Schema.String,
  size: Schema.Number,
});

const DirectoryEntrySchema = Schema.Struct({
  kind: Schema.Literal("directory"),
  path: Schema.String,
});

export const PullManifestSchema = Schema.Struct({
  digestAlgorithm: Schema.Literal("sha256"),
  entries: Schema.Array(Schema.Union([FileEntrySchema, DirectoryEntrySchema])),
  kind: Schema.Union([Schema.Literal("file"), Schema.Literal("directory")]),
  name: Schema.String,
  totalBytes: Schema.Number,
});

export type PullManifest = Schema.Schema.Type<typeof PullManifestSchema>;
export type PullManifestEntry = PullManifest["entries"][number];
export type PullFileEntry = Extract<
  PullManifestEntry,
  { readonly kind: "file" }
>;

export interface PullLimits {
  readonly chunkBytes: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface PullSource {
  readonly manifest: PullManifest;
  readonly read: (entry: PullFileEntry) => AsyncIterable<Uint8Array>;
}

export interface PullResult {
  readonly bytes: number;
  readonly files: number;
}

export class PullPathError extends Schema.TaggedErrorClass<PullPathError>()(
  "PullPathError",
  {
    path: Schema.String,
    reason: Schema.String,
  }
) {}

export class PullNotFoundError extends Schema.TaggedErrorClass<PullNotFoundError>()(
  "PullNotFoundError",
  { path: Schema.String }
) {}

export class PullSymlinkError extends Schema.TaggedErrorClass<PullSymlinkError>()(
  "PullSymlinkError",
  { path: Schema.String }
) {}

export class PullLimitError extends Schema.TaggedErrorClass<PullLimitError>()(
  "PullLimitError",
  {
    limit: Schema.String,
    maximum: Schema.Number,
    observed: Schema.Number,
  }
) {}

export class PullSourceChangedError extends Schema.TaggedErrorClass<PullSourceChangedError>()(
  "PullSourceChangedError",
  { path: Schema.String }
) {}

export class PullDestinationExistsError extends Schema.TaggedErrorClass<PullDestinationExistsError>()(
  "PullDestinationExistsError",
  { path: Schema.String }
) {}

export class PullIntegrityError extends Schema.TaggedErrorClass<PullIntegrityError>()(
  "PullIntegrityError",
  {
    actual: Schema.String,
    expected: Schema.String,
    path: Schema.String,
  }
) {}

export class PullIOError extends Schema.TaggedErrorClass<PullIOError>()(
  "PullIOError",
  {
    operation: Schema.String,
    path: Schema.String,
  }
) {}

export type PullError =
  | PullPathError
  | PullNotFoundError
  | PullSymlinkError
  | PullLimitError
  | PullSourceChangedError
  | PullDestinationExistsError
  | PullIntegrityError
  | PullIOError;

interface Fingerprint {
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
}

interface PlannedFile {
  readonly absolutePath: string;
  readonly entry: PullFileEntry;
  readonly fingerprint: Fingerprint;
}

const defaultLimits: PullLimits = {
  chunkBytes: 64 * 1024,
  maxEntries: 10_000,
  maxFileBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

const compareText = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const fingerprint = (stats: Stats): Fingerprint => ({
  ctimeMs: stats.ctimeMs,
  dev: stats.dev,
  ino: stats.ino,
  mtimeMs: stats.mtimeMs,
  size: stats.size,
});

const fingerprintsMatch = (left: Fingerprint, right: Fingerprint) =>
  left.ctimeMs === right.ctimeMs &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mtimeMs === right.mtimeMs &&
  left.size === right.size;

const isPullError = (cause: unknown): cause is PullError =>
  cause instanceof PullPathError ||
  cause instanceof PullNotFoundError ||
  cause instanceof PullSymlinkError ||
  cause instanceof PullLimitError ||
  cause instanceof PullSourceChangedError ||
  cause instanceof PullDestinationExistsError ||
  cause instanceof PullIntegrityError ||
  cause instanceof PullIOError;

const hasCode = (cause: unknown, code: string) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === code;

const mapPullError = (
  cause: unknown,
  operation: string,
  path: string
): PullError =>
  isPullError(cause) ? cause : new PullIOError({ operation, path });

const limitsFrom = (input: Partial<PullLimits> | undefined): PullLimits => {
  const limits = { ...defaultLimits, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new PullLimitError({
        limit: name,
        maximum: value,
        observed: value,
      });
    }
  }
  return limits;
};

const pathParts = (path: string) => {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    windowsDrivePattern.test(path) ||
    win32.isAbsolute(path)
  ) {
    throw new PullPathError({
      path,
      reason: "path must be canonical and relative",
    });
  }

  const parts = path.split("/");
  if (
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new PullPathError({
      path,
      reason: "path must be canonical and relative",
    });
  }
  return parts;
};

const pathInside = (root: string, path: string) => {
  const offset = relative(root, path);
  return (
    offset.length > 0 &&
    offset !== ".." &&
    !offset.startsWith(`..${sep}`) &&
    !win32.isAbsolute(offset)
  );
};

const fileLimit = (size: number, limits: PullLimits) => {
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) {
    throw new PullLimitError({
      limit: "file bytes",
      maximum: limits.maxFileBytes,
      observed: size,
    });
  }
};

const entryLimit = (count: number, limits: PullLimits) => {
  if (count > limits.maxEntries) {
    throw new PullLimitError({
      limit: "entries",
      maximum: limits.maxEntries,
      observed: count,
    });
  }
};

const totalLimit = (total: number, limits: PullLimits) => {
  if (!Number.isSafeInteger(total) || total > limits.maxTotalBytes) {
    throw new PullLimitError({
      limit: "total bytes",
      maximum: limits.maxTotalBytes,
      observed: total,
    });
  }
};

const lstatRemote = async (absolutePath: string, remotePath: string) => {
  try {
    return await lstat(absolutePath);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) {
      // biome-ignore lint/style/useErrorCause: Host filesystem details stay local.
      throw new PullNotFoundError({ path: remotePath });
    }
    throw cause;
  }
};

const hashPlannedFile = async (
  absolutePath: string,
  remotePath: string,
  limits: PullLimits
) => {
  const handle = await open(absolutePath, readOnlyNoFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new PullPathError({
        path: remotePath,
        reason: "not a regular file",
      });
    }
    fileLimit(before.size, limits);

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(limits.chunkBytes);
    let bytesRead = buffer.byteLength;
    let offset = 0;
    while (bytesRead > 0) {
      // biome-ignore lint/performance/noAwaitInLoops: File offsets are read sequentially.
      ({ bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset));
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
    }

    const after = await handle.stat();
    const beforeFingerprint = fingerprint(before);
    if (
      offset !== before.size ||
      !fingerprintsMatch(beforeFingerprint, fingerprint(after))
    ) {
      throw new PullSourceChangedError({ path: remotePath });
    }

    const pathStats = await lstatRemote(absolutePath, remotePath);
    if (
      pathStats.isSymbolicLink() ||
      !fingerprintsMatch(beforeFingerprint, fingerprint(pathStats))
    ) {
      throw new PullSourceChangedError({ path: remotePath });
    }

    return {
      digest: hash.digest("hex"),
      fingerprint: beforeFingerprint,
      size: before.size,
    };
  } finally {
    await handle.close();
  }
};

const changed = (path: string): PullSourceChangedError =>
  new PullSourceChangedError({ path });

const failedRead = async function* (
  error: PullSourceChangedError
): AsyncGenerator<Uint8Array> {
  yield await Promise.reject<Uint8Array>(error);
};

const openPlannedFile = async (file: PlannedFile) => {
  try {
    return await open(file.absolutePath, readOnlyNoFollow);
  } catch {
    // biome-ignore lint/style/useErrorCause: Source paths and host errors stay local.
    throw changed(file.entry.path);
  }
};

const statPlannedPath = async (file: PlannedFile) => {
  try {
    return await lstat(file.absolutePath);
  } catch {
    // biome-ignore lint/style/useErrorCause: Source paths and host errors stay local.
    throw changed(file.entry.path);
  }
};

const readPlannedFile = async function* (
  file: PlannedFile,
  chunkBytes: number
): AsyncGenerator<Uint8Array> {
  const handle = await openPlannedFile(file);
  try {
    const before = await handle.stat();
    if (
      !(
        before.isFile() &&
        fingerprintsMatch(file.fingerprint, fingerprint(before))
      )
    ) {
      throw changed(file.entry.path);
    }

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(chunkBytes);
    let bytesRead = buffer.byteLength;
    let offset = 0;
    while (bytesRead > 0) {
      // biome-ignore lint/performance/noAwaitInLoops: File offsets are read sequentially.
      ({ bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset));
      if (bytesRead > 0) {
        const chunk = Uint8Array.from(buffer.subarray(0, bytesRead));
        hash.update(chunk);
        offset += bytesRead;
        yield chunk;
      }
    }

    const after = await handle.stat();
    const pathStats = await statPlannedPath(file);
    if (
      offset !== file.entry.size ||
      hash.digest("hex") !== file.entry.digest ||
      pathStats.isSymbolicLink() ||
      !fingerprintsMatch(file.fingerprint, fingerprint(after)) ||
      !fingerprintsMatch(file.fingerprint, fingerprint(pathStats))
    ) {
      throw changed(file.entry.path);
    }
  } finally {
    await handle.close();
  }
};

const preparePullPromise = async (options: {
  readonly limits?: Partial<PullLimits>;
  readonly remotePath: string;
  readonly servedRoot: string;
}): Promise<PullSource> => {
  const limits = limitsFrom(options.limits);
  const parts = pathParts(options.remotePath);
  const root = await realpath(options.servedRoot);
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory()) {
    throw new PullPathError({ path: "served root", reason: "not a directory" });
  }

  const target = resolve(root, ...parts);
  if (!pathInside(root, target)) {
    throw new PullPathError({
      path: options.remotePath,
      reason: "path escapes the served root",
    });
  }

  const targetStats = await lstatRemote(target, options.remotePath);
  if (targetStats.isSymbolicLink()) {
    throw new PullSymlinkError({ path: options.remotePath });
  }

  const entries: PullManifestEntry[] = [];
  const files = new Map<string, PlannedFile>();
  let totalBytes = 0;

  const addFile = async (
    absolutePath: string,
    entryPath: string,
    displayPath: string
  ) => {
    const planned = await hashPlannedFile(absolutePath, displayPath, limits);
    const entry: PullFileEntry = {
      digest: planned.digest,
      kind: "file",
      path: entryPath,
      size: planned.size,
    };
    entries.push(entry);
    entryLimit(entries.length, limits);
    totalBytes += entry.size;
    totalLimit(totalBytes, limits);
    files.set(entry.path, {
      absolutePath,
      entry,
      fingerprint: planned.fingerprint,
    });
  };

  const walk = async (
    absoluteDirectory: string,
    relativeDirectory: string,
    displayDirectory: string
  ): Promise<void> => {
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => compareText(left.name, right.name));

    for (const child of children) {
      const entryPath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      const displayPath = `${displayDirectory}/${child.name}`;
      pathParts(entryPath);
      const absolutePath = join(absoluteDirectory, child.name);
      // biome-ignore lint/performance/noAwaitInLoops: Tree entries are planned in deterministic order.
      const stats = await lstatRemote(absolutePath, displayPath);
      if (stats.isSymbolicLink()) {
        throw new PullSymlinkError({ path: displayPath });
      }
      if (stats.isDirectory()) {
        entries.push({ kind: "directory", path: entryPath });
        entryLimit(entries.length, limits);
        await walk(absolutePath, entryPath, displayPath);
      } else if (stats.isFile()) {
        await addFile(absolutePath, entryPath, displayPath);
      } else {
        throw new PullPathError({
          path: displayPath,
          reason: "not a regular file or directory",
        });
      }
    }
  };

  const name = parts.at(-1);
  if (!name) {
    throw new PullPathError({
      path: options.remotePath,
      reason: "path has no file name",
    });
  }

  let kind: PullManifest["kind"];
  if (targetStats.isFile()) {
    kind = "file";
    await addFile(target, name, options.remotePath);
  } else if (targetStats.isDirectory()) {
    kind = "directory";
    await walk(target, "", options.remotePath);
  } else {
    throw new PullPathError({
      path: options.remotePath,
      reason: "not a regular file or directory",
    });
  }

  entries.sort((left, right) => compareText(left.path, right.path));
  const manifest: PullManifest = {
    digestAlgorithm: "sha256",
    entries,
    kind,
    name,
    totalBytes,
  };

  return {
    manifest,
    read: (entry) => {
      const file = files.get(entry.path);
      if (
        !file ||
        file.entry.digest !== entry.digest ||
        file.entry.size !== entry.size
      ) {
        return failedRead(changed(entry.path));
      }
      return readPlannedFile(file, limits.chunkBytes);
    },
  };
};

const decodeManifest = Schema.decodeUnknownSync(PullManifestSchema);

const manifestFrom = (input: unknown, limits: PullLimits): PullManifest => {
  let manifest: PullManifest;
  try {
    manifest = decodeManifest(input);
  } catch {
    // biome-ignore lint/style/useErrorCause: Decoder details are not part of the wire error.
    throw new PullIntegrityError({
      actual: "invalid manifest",
      expected: "valid manifest",
      path: "manifest",
    });
  }

  const nameParts = pathParts(manifest.name);
  if (nameParts.length !== 1) {
    throw new PullPathError({
      path: manifest.name,
      reason: "manifest name must have one component",
    });
  }
  entryLimit(manifest.entries.length, limits);

  const directories = new Set<string>();
  const paths = new Set<string>();
  let totalBytes = 0;
  let previousPath = "";
  for (const entry of manifest.entries) {
    const parts = pathParts(entry.path);
    if (paths.has(entry.path) || compareText(previousPath, entry.path) >= 0) {
      throw new PullIntegrityError({
        actual: entry.path,
        expected: "unique entries in lexical order",
        path: "manifest",
      });
    }
    paths.add(entry.path);
    previousPath = entry.path;

    const parentParts = parts.slice(0, -1);
    for (let index = 1; index <= parentParts.length; index += 1) {
      const parent = parentParts.slice(0, index).join("/");
      if (!directories.has(parent)) {
        throw new PullIntegrityError({
          actual: entry.path,
          expected: `declared parent directory ${parent}`,
          path: "manifest",
        });
      }
    }

    if (entry.kind === "directory") {
      directories.add(entry.path);
      continue;
    }
    fileLimit(entry.size, limits);
    if (!digestPattern.test(entry.digest)) {
      throw new PullIntegrityError({
        actual: entry.digest,
        expected: "lowercase sha256 digest",
        path: entry.path,
      });
    }
    totalBytes += entry.size;
    totalLimit(totalBytes, limits);
  }

  if (manifest.totalBytes !== totalBytes) {
    throw new PullIntegrityError({
      actual: String(manifest.totalBytes),
      expected: String(totalBytes),
      path: "manifest",
    });
  }
  if (
    manifest.kind === "file" &&
    (manifest.entries.length !== 1 ||
      manifest.entries[0]?.kind !== "file" ||
      manifest.entries[0].path !== manifest.name)
  ) {
    throw new PullIntegrityError({
      actual: "invalid file manifest",
      expected: "one named file entry",
      path: "manifest",
    });
  }

  return manifest;
};

const destinationExists = async (path: string) => {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) {
      return false;
    }
    throw cause;
  }
};

const writeChunk = async (
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array
) => {
  let offset = 0;
  while (offset < chunk.byteLength) {
    // biome-ignore lint/performance/noAwaitInLoops: Partial writes must preserve byte order.
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset
    );
    if (bytesWritten === 0) {
      throw new PullIOError({
        operation: "write staged file",
        path: "destination",
      });
    }
    offset += bytesWritten;
  }
};

const writeEntry = async (
  target: string,
  entry: PullFileEntry,
  read: (entry: PullFileEntry) => AsyncIterable<Uint8Array>,
  signal: AbortSignal
) => {
  const handle = await open(target, "wx", 0o600);
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of read(entry)) {
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) {
        throw new PullIntegrityError({
          actual: typeof chunk,
          expected: "Uint8Array",
          path: entry.path,
        });
      }
      bytes += chunk.byteLength;
      if (bytes > entry.size) {
        throw new PullIntegrityError({
          actual: String(bytes),
          expected: String(entry.size),
          path: entry.path,
        });
      }
      hash.update(chunk);
      await writeChunk(handle, chunk);
    }

    const digest = hash.digest("hex");
    if (bytes !== entry.size || digest !== entry.digest) {
      throw new PullIntegrityError({
        actual: `${bytes}:${digest}`,
        expected: `${entry.size}:${entry.digest}`,
        path: entry.path,
      });
    }
  } finally {
    await handle.close();
  }
};

const commitDestination = async (
  payload: string,
  destination: string,
  kind: PullManifest["kind"]
) => {
  if (await destinationExists(destination)) {
    throw new PullDestinationExistsError({ path: destination });
  }
  try {
    if (kind === "file") {
      await link(payload, destination);
    } else {
      await rename(payload, destination);
    }
  } catch (cause) {
    if (hasCode(cause, "EEXIST") || hasCode(cause, "ENOTEMPTY")) {
      // biome-ignore lint/style/useErrorCause: Destination races expose no host details.
      throw new PullDestinationExistsError({ path: destination });
    }
    throw cause;
  }
};

const materializePullPromise = async (
  options: {
    readonly destination: string;
    readonly limits?: Partial<PullLimits>;
    readonly manifest: unknown;
    readonly read: (entry: PullFileEntry) => AsyncIterable<Uint8Array>;
  },
  signal: AbortSignal
): Promise<PullResult> => {
  const limits = limitsFrom(options.limits);
  const manifest = manifestFrom(options.manifest, limits);
  const destination = resolve(options.destination);
  if (await destinationExists(destination)) {
    throw new PullDestinationExistsError({ path: options.destination });
  }

  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, ".dumbridge-pull-"));
  const payload = join(stage, "payload");

  try {
    if (manifest.kind === "directory") {
      await mkdir(payload);
    }

    let files = 0;
    for (const entry of manifest.entries) {
      signal.throwIfAborted();
      const target =
        manifest.kind === "file"
          ? payload
          : join(payload, ...entry.path.split("/"));
      if (entry.kind === "directory") {
        // biome-ignore lint/performance/noAwaitInLoops: Manifest entries commit in declared order.
        await mkdir(target);
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeEntry(target, entry, options.read, signal);
        files += 1;
      }
    }

    await commitDestination(payload, destination, manifest.kind);
    return { bytes: manifest.totalBytes, files };
  } finally {
    await rm(stage, { force: true, recursive: true });
  }
};

export const preparePull = Effect.fn("PullTransfer.prepare")(
  (options: {
    readonly limits?: Partial<PullLimits>;
    readonly remotePath: string;
    readonly servedRoot: string;
  }) =>
    Effect.tryPromise({
      catch: (cause) => mapPullError(cause, "prepare pull", options.remotePath),
      try: () => preparePullPromise(options),
    })
);

export const materializePull = Effect.fn("PullTransfer.materialize")(
  (options: {
    readonly destination: string;
    readonly limits?: Partial<PullLimits>;
    readonly manifest: unknown;
    readonly read: (entry: PullFileEntry) => AsyncIterable<Uint8Array>;
  }) =>
    Effect.tryPromise({
      catch: (cause) =>
        mapPullError(cause, "materialize pull", options.destination),
      try: (signal) => materializePullPromise(options, signal),
    })
);
