import { parseRemotePath } from "@dumbridge/remote-path";
import { type Effect, Result, Schema, type Stream } from "effect";
import {
  type PullError,
  PullIntegrityError,
  PullLimitError,
  PullPathError,
} from "./errors";

const digestPattern = /^[0-9a-f]{64}$/;
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

const PullManifestSchema = Schema.Struct({
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
  readonly read: PullRead;
  readonly verify: Effect.Effect<void, PullError>;
}

export type PullRead = (
  entry: PullFileEntry,
  signal: AbortSignal
) => Stream.Stream<Uint8Array, PullError>;

export interface PullResult {
  readonly bytes: number;
  readonly files: number;
}

const defaultLimits: PullLimits = {
  chunkBytes: 64 * 1024,
  maxEntries: 4096,
  maxFileBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

export const compareText = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

export const limitsFrom = (
  input: Partial<PullLimits> | undefined
): PullLimits => {
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

export const pathParts = (path: string): readonly string[] => {
  const parsed = parseRemotePath(path);
  if (Result.isFailure(parsed)) {
    throw new PullPathError({
      path,
      reason: "path must be canonical and relative",
    });
  }
  return parsed.success.segments;
};

export const resolvePullDestination = (
  remotePath: string,
  destination?: string
): string => {
  const parts = pathParts(remotePath);
  if (destination !== undefined) {
    return destination;
  }

  const name = parts.at(-1);
  if (!name) {
    throw new PullPathError({
      path: remotePath,
      reason: "path has no file name",
    });
  }
  return `./${name}`;
};

export const fileLimit = (size: number, limits: PullLimits) => {
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) {
    throw new PullLimitError({
      limit: "file bytes",
      maximum: limits.maxFileBytes,
      observed: size,
    });
  }
};

export const entryLimit = (count: number, limits: PullLimits) => {
  if (count > limits.maxEntries) {
    throw new PullLimitError({
      limit: "entries",
      maximum: limits.maxEntries,
      observed: count,
    });
  }
};

export const totalLimit = (total: number, limits: PullLimits) => {
  if (!Number.isSafeInteger(total) || total > limits.maxTotalBytes) {
    throw new PullLimitError({
      limit: "total bytes",
      maximum: limits.maxTotalBytes,
      observed: total,
    });
  }
};

const decodeManifest = Schema.decodeUnknownSync(PullManifestSchema);

export const manifestFrom = (
  input: unknown,
  limits: PullLimits
): PullManifest => {
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
