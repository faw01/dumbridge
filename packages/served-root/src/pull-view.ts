import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { promises as hostFileSystem, type Stats } from "node:fs";
import { join } from "node:path";
import { parseRemotePath } from "@dumbridge/remote-path";
import { Result } from "effect";
import {
  ServedRootChangedError,
  ServedRootEntryTypeError,
  ServedRootFileLimitError,
  ServedRootIOError,
  ServedRootNotFoundError,
  ServedRootPathError,
  ServedRootSourceChangedError,
  ServedRootSymlinkError,
  sourceChanged,
} from "./errors";
import {
  type AsyncPathGuard,
  type AsyncPathResourceGuard,
  isMissingPath,
  readOnlyNoFollowNonBlocking,
  virtualRoot,
} from "./host-paths";
import {
  type SourceDirectory,
  type SourceEntry,
  type SourceFileExpectation,
  type SourceFileScan,
  type SourceRevision,
  sourceEntryFrom,
  sourceRevisionMatches,
} from "./source-revision";

export interface ServedRootPullView {
  readonly inspect: (
    path: string,
    options: { readonly expected?: SourceRevision },
    signal: AbortSignal
  ) => Promise<SourceEntry>;
  readonly list: (
    path: string,
    options: {
      readonly expected?: SourceRevision;
      readonly reserve: () => void;
    },
    signal: AbortSignal
  ) => Promise<SourceDirectory>;
  readonly scan: (options: {
    readonly chunkBytes: number;
    readonly expected?: SourceFileExpectation;
    readonly maxFileBytes: number;
    readonly path: string;
    readonly signal: AbortSignal;
  }) => AsyncGenerator<Uint8Array, SourceFileScan>;
}

interface ParsedSourcePath {
  readonly parts: readonly string[];
  readonly path: string;
  readonly virtualPath: string;
}

interface InspectedSourcePath {
  readonly entry: SourceEntry;
  readonly hostPath: string;
}

class SourceReservationFailure {
  readonly cause: unknown;

  constructor(cause: unknown) {
    this.cause = cause;
  }
}

const parsedSourcePath = (path: string): ParsedSourcePath => {
  const parsed = parseRemotePath(path);
  if (Result.isFailure(parsed)) {
    throw new ServedRootPathError({
      path,
      reason: "path must be canonical and relative",
    });
  }
  return {
    parts: parsed.success.segments,
    path,
    virtualPath: `${virtualRoot}/${path}`,
  };
};

const requireSourceKind = <Kind extends "directory" | "file">(
  entry: SourceEntry,
  expected: Kind
): Extract<SourceEntry, { readonly kind: Kind }> => {
  if (entry.kind !== expected) {
    throw new ServedRootEntryTypeError({
      actual: entry.kind,
      expected,
      path: entry.path,
    });
  }
  return entry as Extract<SourceEntry, { readonly kind: Kind }>;
};

const inspectSourcePath = async (options: {
  readonly expected: SourceRevision | undefined;
  readonly hostRoot: string;
  readonly parsed: ParsedSourcePath;
  readonly signal: AbortSignal;
}): Promise<InspectedSourcePath> => {
  let hostPath = options.hostRoot;
  let stats: Stats | undefined;
  for (const [index, part] of options.parsed.parts.entries()) {
    options.signal.throwIfAborted();
    hostPath = join(hostPath, part);
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Source components must be checked in order.
      stats = await hostFileSystem.lstat(hostPath);
    } catch (cause) {
      options.signal.throwIfAborted();
      if (isMissingPath(cause)) {
        if (options.expected !== undefined) {
          throw sourceChanged(options.parsed.path);
        }
        // biome-ignore lint/style/useErrorCause: The Node cause may expose the host path.
        throw new ServedRootNotFoundError({
          path: options.parsed.parts.slice(0, index + 1).join("/"),
        });
      }
      throw cause;
    }
    options.signal.throwIfAborted();
    if (stats.isSymbolicLink()) {
      throw new ServedRootSymlinkError({
        path: options.parsed.parts.slice(0, index + 1).join("/"),
      });
    }
  }
  if (stats === undefined) {
    throw new ServedRootPathError({
      path: options.parsed.path,
      reason: "path must have at least one component",
    });
  }
  if (
    options.expected !== undefined &&
    !sourceRevisionMatches(options.expected, stats)
  ) {
    throw sourceChanged(options.parsed.path);
  }
  return {
    entry: sourceEntryFrom(options.parsed.path, stats),
    hostPath,
  };
};

const isServedRootPullError = (cause: unknown) =>
  cause instanceof ServedRootPathError ||
  cause instanceof ServedRootNotFoundError ||
  cause instanceof ServedRootSymlinkError ||
  cause instanceof ServedRootEntryTypeError ||
  cause instanceof ServedRootSourceChangedError ||
  cause instanceof ServedRootFileLimitError ||
  cause instanceof ServedRootIOError ||
  cause instanceof ServedRootChangedError;

const mapServedRootPullError = (options: {
  readonly cause: unknown;
  readonly expected: boolean;
  readonly operation: string;
  readonly path: string;
  readonly signal: AbortSignal;
}): unknown => {
  if (
    options.cause instanceof SourceReservationFailure ||
    isServedRootPullError(options.cause)
  ) {
    return options.cause;
  }
  if (options.signal.aborted) {
    return options.signal.reason ?? options.cause;
  }
  if (isMissingPath(options.cause)) {
    return options.expected
      ? sourceChanged(options.path)
      : new ServedRootNotFoundError({ path: options.path });
  }
  return new ServedRootIOError({
    operation: options.operation,
    path: options.path,
  });
};

const enforceSourceFileLimit = (
  path: string,
  observed: number,
  maximum: number
) => {
  if (!Number.isSafeInteger(observed) || observed < 0 || observed > maximum) {
    throw new ServedRootFileLimitError({ maximum, observed, path });
  }
};

const compareSourceNames = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

export class PullView {
  readonly #guardPaths: AsyncPathGuard;
  readonly #guardResource: AsyncPathResourceGuard;
  readonly #hostRoot: string;

  constructor(
    hostRoot: string,
    guardPaths: AsyncPathGuard,
    guardResource: AsyncPathResourceGuard
  ) {
    this.#hostRoot = hostRoot;
    this.#guardPaths = guardPaths;
    this.#guardResource = guardResource;
  }

  async inspect(
    path: string,
    options: { readonly expected?: SourceRevision },
    signal: AbortSignal
  ): Promise<SourceEntry> {
    try {
      signal.throwIfAborted();
      const parsed = parsedSourcePath(path);
      const inspected = await this.#guardPaths([parsed.virtualPath], () =>
        inspectSourcePath({
          expected: options.expected,
          hostRoot: this.#hostRoot,
          parsed,
          signal,
        })
      );
      signal.throwIfAborted();
      return inspected.entry;
    } catch (cause) {
      throw mapServedRootPullError({
        cause,
        expected: options.expected !== undefined,
        operation: "inspect source",
        path,
        signal,
      });
    }
  }

  async list(
    path: string,
    options: {
      readonly expected?: SourceRevision;
      readonly reserve: () => void;
    },
    signal: AbortSignal
  ): Promise<SourceDirectory> {
    try {
      signal.throwIfAborted();
      const parsed = parsedSourcePath(path);
      const result = await this.#guardPaths([parsed.virtualPath], async () => {
        const inspected = await inspectSourcePath({
          expected: options.expected,
          hostRoot: this.#hostRoot,
          parsed,
          signal,
        });
        const directoryEntry = requireSourceKind(inspected.entry, "directory");
        signal.throwIfAborted();
        const directory = await hostFileSystem.opendir(inspected.hostPath, {
          bufferSize: 1,
        });
        const children: string[] = [];
        try {
          let child = await directory.read();
          while (child !== null) {
            signal.throwIfAborted();
            try {
              options.reserve();
            } catch (cause) {
              // biome-ignore lint/style/useErrorCause: The wrapper preserves and later rethrows the exact caller error.
              throw new SourceReservationFailure(cause);
            }
            children.push(child.name);
            // biome-ignore lint/performance/noAwaitInLoops: Directory reads stop when the caller's reservation limit is reached.
            child = await directory.read();
          }
          signal.throwIfAborted();
        } catch (cause) {
          try {
            await directory.close();
          } catch {
            //
          }
          throw cause;
        }
        await directory.close();
        await inspectSourcePath({
          expected: directoryEntry.revision,
          hostRoot: this.#hostRoot,
          parsed,
          signal,
        });
        children.sort(compareSourceNames);
        return Object.freeze({
          children: Object.freeze(children),
          path,
          revision: directoryEntry.revision,
        });
      });
      signal.throwIfAborted();
      return result;
    } catch (cause) {
      const mapped = mapServedRootPullError({
        cause,
        expected: options.expected !== undefined,
        operation: "list source directory",
        path,
        signal,
      });
      if (mapped instanceof SourceReservationFailure) {
        throw mapped.cause;
      }
      throw mapped;
    }
  }

  async *scan(options: {
    readonly chunkBytes: number;
    readonly expected?: SourceFileExpectation;
    readonly maxFileBytes: number;
    readonly path: string;
    readonly signal: AbortSignal;
  }): AsyncGenerator<Uint8Array, SourceFileScan> {
    try {
      options.signal.throwIfAborted();
      const parsed = parsedSourcePath(options.path);
      const opened = await this.#guardResource(
        [parsed.virtualPath],
        async () => {
          const inspected = await inspectSourcePath({
            expected: options.expected?.revision,
            hostRoot: this.#hostRoot,
            parsed,
            signal: options.signal,
          });
          const entry = requireSourceKind(inspected.entry, "file");
          enforceSourceFileLimit(
            options.path,
            entry.size,
            options.maxFileBytes
          );
          if (
            options.expected !== undefined &&
            entry.size !== options.expected.size
          ) {
            throw sourceChanged(options.path);
          }
          options.signal.throwIfAborted();
          const handle = await hostFileSystem.open(
            inspected.hostPath,
            readOnlyNoFollowNonBlocking
          );
          return { entry, handle };
        },
        ({ handle }) => handle.close()
      );

      let closeFailure: unknown;
      let scanResult: SourceFileScan;
      try {
        options.signal.throwIfAborted();
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(options.chunkBytes);
        let bytesRead = buffer.byteLength;
        let offset = 0;
        while (bytesRead > 0) {
          options.signal.throwIfAborted();
          // biome-ignore lint/performance/noAwaitInLoops: File offsets are read sequentially and each result is checked before it is yielded.
          const read = await this.#guardPaths(
            [parsed.virtualPath],
            async () => {
              await inspectSourcePath({
                expected: opened.entry.revision,
                hostRoot: this.#hostRoot,
                parsed,
                signal: options.signal,
              });
              const before = await opened.handle.stat();
              if (!sourceRevisionMatches(opened.entry.revision, before)) {
                throw sourceChanged(options.path);
              }
              const result = await opened.handle.read(
                buffer,
                0,
                buffer.byteLength,
                offset
              );
              const after = await opened.handle.stat();
              if (!sourceRevisionMatches(opened.entry.revision, after)) {
                throw sourceChanged(options.path);
              }
              await inspectSourcePath({
                expected: opened.entry.revision,
                hostRoot: this.#hostRoot,
                parsed,
                signal: options.signal,
              });
              options.signal.throwIfAborted();
              return result;
            }
          );
          ({ bytesRead } = read);
          if (bytesRead > 0) {
            const nextOffset = offset + bytesRead;
            enforceSourceFileLimit(
              options.path,
              nextOffset,
              options.maxFileBytes
            );
            if (
              options.expected !== undefined &&
              nextOffset > options.expected.size
            ) {
              throw sourceChanged(options.path);
            }
            const chunk = Uint8Array.from(buffer.subarray(0, bytesRead));
            hash.update(chunk);
            offset = nextOffset;
            options.signal.throwIfAborted();
            yield chunk;
          }
        }

        const digest = hash.digest("hex");
        if (
          offset !== opened.entry.size ||
          (options.expected !== undefined &&
            (offset !== options.expected.size ||
              digest !== options.expected.digest))
        ) {
          throw sourceChanged(options.path);
        }
        options.signal.throwIfAborted();
        scanResult = Object.freeze({
          digest,
          revision: opened.entry.revision,
          size: opened.entry.size,
        });
      } finally {
        try {
          await opened.handle.close();
        } catch (cause) {
          closeFailure = cause;
        }
      }
      if (closeFailure !== undefined) {
        throw closeFailure;
      }
      return scanResult;
    } catch (cause) {
      throw mapServedRootPullError({
        cause,
        expected: options.expected !== undefined,
        operation: "scan source file",
        path: options.path,
        signal: options.signal,
      });
    }
  }
}
