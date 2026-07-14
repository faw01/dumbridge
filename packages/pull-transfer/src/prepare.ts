import type {
  ServedRoot,
  ServedRootPullView,
  SourceEntry,
  SourceRevision,
} from "@dumbridge/served-root";
import type {
  PullFileEntry,
  PullManifest,
  PullManifestEntry,
} from "@dumbridge/wire";
import { Effect, Stream } from "effect";
import type { PullError } from "./errors";
import { changed, mapPullError, PullPathError } from "./errors";
import {
  compareText,
  entryLimit,
  fileLimit,
  limitsFrom,
  type PullLimits,
  type PullSource,
  pathParts,
  totalLimit,
} from "./model";

interface PlannedFile {
  readonly displayPath: string;
  readonly entry: PullFileEntry;
  readonly revision: SourceRevision;
  readonly view: ServedRootPullView;
}

interface PlannedDirectory {
  readonly children: readonly string[];
  readonly displayPath: string;
  readonly revision: SourceRevision;
}

const planSourceFile = async (options: {
  readonly displayPath: string;
  readonly limits: PullLimits;
  readonly signal: AbortSignal;
  readonly view: ServedRootPullView;
}) => {
  const scanner = options.view.scan({
    chunkBytes: options.limits.chunkBytes,
    maxFileBytes: options.limits.maxFileBytes,
    path: options.displayPath,
    signal: options.signal,
  });
  let result = await scanner.next();
  while (!result.done) {
    // biome-ignore lint/performance/noAwaitInLoops: Planning must consume the stable file scan fully.
    result = await scanner.next();
  }
  return result.value;
};

const streamPlannedFile = (
  file: PlannedFile,
  limits: PullLimits,
  signal: AbortSignal
): Stream.Stream<Uint8Array, PullError> =>
  Stream.fromAsyncIterable(
    file.view.scan({
      chunkBytes: limits.chunkBytes,
      expected: {
        digest: file.entry.digest,
        revision: file.revision,
        size: file.entry.size,
      },
      maxFileBytes: limits.maxFileBytes,
      path: file.displayPath,
      signal,
    }),
    (cause) => mapPullError(cause, "stream source file", file.displayPath)
  );

const sameNames = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length &&
  actual.every((name, index) => name === expected[index]);

const verifyPullSourcePromise = async (options: {
  readonly directories: ReadonlyMap<string, PlannedDirectory>;
  readonly files: ReadonlyMap<string, PlannedFile>;
  readonly limits: PullLimits;
  readonly manifest: PullManifest;
  readonly servedRoot: ServedRoot;
  readonly signal: AbortSignal;
}) => {
  options.signal.throwIfAborted();
  options.servedRoot.verifySync();
  const view = options.servedRoot.openPullView();

  let discoveredEntries = 0;
  let recheckedEntries = 0;
  let totalBytes = 0;
  const reserveEntry = () => {
    discoveredEntries += 1;
    entryLimit(discoveredEntries, options.limits);
  };
  const reserveRecheckEntry = () => {
    recheckedEntries += 1;
    entryLimit(recheckedEntries, options.limits);
  };

  const verifyFile = async (file: PlannedFile) => {
    options.signal.throwIfAborted();
    const entry = await view.inspect(
      file.displayPath,
      { expected: file.revision },
      options.signal
    );
    if (entry.kind !== "file") {
      throw changed(file.displayPath);
    }
    fileLimit(entry.size, options.limits);
    totalBytes += entry.size;
    totalLimit(totalBytes, options.limits);
  };

  const verifyDirectory = async (
    relativePath: string,
    planned: PlannedDirectory
  ): Promise<void> => {
    options.signal.throwIfAborted();
    const listed = await view.list(
      planned.displayPath,
      {
        reserve: reserveEntry,
      },
      options.signal
    );
    if (!sameNames(listed.children, planned.children)) {
      throw changed(planned.displayPath);
    }
    const currentDirectory = await view.inspect(
      planned.displayPath,
      { expected: planned.revision },
      options.signal
    );
    if (currentDirectory.kind !== "directory") {
      throw changed(planned.displayPath);
    }

    for (const childName of listed.children) {
      options.signal.throwIfAborted();
      const entryPath = relativePath
        ? `${relativePath}/${childName}`
        : childName;
      const directory = options.directories.get(entryPath);
      if (directory) {
        // biome-ignore lint/performance/noAwaitInLoops: Planned entries are verified in deterministic order.
        await verifyDirectory(entryPath, directory);
        continue;
      }
      const file = options.files.get(entryPath);
      if (!file) {
        throw changed(`${planned.displayPath}/${childName}`);
      }
      await verifyFile(file);
    }

    const rechecked = await view.list(
      planned.displayPath,
      {
        reserve: reserveRecheckEntry,
      },
      options.signal
    );
    if (!sameNames(rechecked.children, planned.children)) {
      throw changed(planned.displayPath);
    }
    const recheckedDirectory = await view.inspect(
      planned.displayPath,
      { expected: planned.revision },
      options.signal
    );
    if (recheckedDirectory.kind !== "directory") {
      throw changed(planned.displayPath);
    }
  };

  if (options.manifest.kind === "file") {
    reserveEntry();
    const file = options.files.get(options.manifest.name);
    if (!file) {
      throw changed(options.manifest.name);
    }
    await verifyFile(file);
  } else {
    const rootDirectory = options.directories.get("");
    if (!rootDirectory) {
      throw changed(options.manifest.name);
    }
    await verifyDirectory("", rootDirectory);
  }

  if (totalBytes !== options.manifest.totalBytes) {
    throw changed(options.manifest.name);
  }
  options.signal.throwIfAborted();
  options.servedRoot.verifySync();
};

const preparePullPromise = async (
  options: {
    readonly limits?: Partial<PullLimits>;
    readonly remotePath: string;
    readonly servedRoot: ServedRoot;
  },
  prepareSignal: AbortSignal
): Promise<PullSource> => {
  prepareSignal.throwIfAborted();
  const limits = limitsFrom(options.limits);
  const parts = pathParts(options.remotePath);
  options.servedRoot.verifySync();
  const view = options.servedRoot.openPullView();
  const target = await view.inspect(options.remotePath, {}, prepareSignal);

  const entries: PullManifestEntry[] = [];
  const directories = new Map<string, PlannedDirectory>();
  const files = new Map<string, PlannedFile>();
  let discoveredEntries = 0;
  let totalBytes = 0;

  const reserveEntry = () => {
    const nextCount = discoveredEntries + 1;
    entryLimit(nextCount, limits);
    discoveredEntries = nextCount;
  };

  const addFile = async (
    entryPath: string,
    displayPath: string,
    observed: Extract<SourceEntry, { readonly kind: "file" }>
  ) => {
    fileLimit(observed.size, limits);
    totalLimit(totalBytes + observed.size, limits);
    const planned = await planSourceFile({
      displayPath,
      limits,
      signal: prepareSignal,
      view,
    });
    const entry: PullFileEntry = {
      digest: planned.digest,
      kind: "file",
      path: entryPath,
      size: planned.size,
    };
    entries.push(entry);
    const nextTotal = totalBytes + entry.size;
    totalLimit(nextTotal, limits);
    totalBytes = nextTotal;
    files.set(entry.path, {
      displayPath,
      entry,
      revision: planned.revision,
      view,
    });
  };

  const walk = async (
    relativeDirectory: string,
    displayDirectory: string,
    observed: Extract<SourceEntry, { readonly kind: "directory" }>
  ): Promise<void> => {
    const listed = await view.list(
      displayDirectory,
      {
        expected: observed.revision,
        reserve: reserveEntry,
      },
      prepareSignal
    );
    directories.set(relativeDirectory, {
      children: listed.children,
      displayPath: displayDirectory,
      revision: listed.revision,
    });

    for (const childName of listed.children) {
      prepareSignal.throwIfAborted();
      const entryPath = relativeDirectory
        ? `${relativeDirectory}/${childName}`
        : childName;
      const displayPath = `${displayDirectory}/${childName}`;
      pathParts(entryPath);
      // biome-ignore lint/performance/noAwaitInLoops: Tree entries are planned in deterministic order.
      const child = await view.inspect(displayPath, {}, prepareSignal);
      if (child.kind === "directory") {
        entries.push({ kind: "directory", path: entryPath });
        await walk(entryPath, displayPath, child);
      } else if (child.kind === "file") {
        await addFile(entryPath, displayPath, child);
      } else {
        throw new PullPathError({
          path: displayPath,
          reason: "not a regular file or directory",
        });
      }
    }
  };

  const manifestName = parts.at(-1);
  if (!manifestName) {
    throw new PullPathError({
      path: options.remotePath,
      reason: "path has no file name",
    });
  }

  let kind: PullManifest["kind"];
  if (target.kind === "file") {
    kind = "file";
    reserveEntry();
    await addFile(manifestName, options.remotePath, target);
  } else if (target.kind === "directory") {
    kind = "directory";
    await walk("", options.remotePath, target);
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
    name: manifestName,
    totalBytes,
  };
  prepareSignal.throwIfAborted();
  options.servedRoot.verifySync();

  return {
    manifest,
    read: (entry, signal) => {
      const file = files.get(entry.path);
      if (
        !file ||
        file.entry.digest !== entry.digest ||
        file.entry.size !== entry.size
      ) {
        return Stream.fail(changed(entry.path));
      }
      return streamPlannedFile(file, limits, signal);
    },
    verify: Effect.tryPromise({
      catch: (cause) =>
        mapPullError(cause, "verify pull source", options.remotePath),
      try: (signal) =>
        verifyPullSourcePromise({
          directories,
          files,
          limits,
          manifest,
          servedRoot: options.servedRoot,
          signal,
        }),
    }),
  };
};

export const preparePull = Effect.fn("PullTransfer.prepare")(
  (options: {
    readonly limits?: Partial<PullLimits>;
    readonly remotePath: string;
    readonly servedRoot: ServedRoot;
  }) =>
    Effect.tryPromise({
      catch: (cause) => mapPullError(cause, "prepare pull", options.remotePath),
      try: (signal) => preparePullPromise(options, signal),
    })
);
