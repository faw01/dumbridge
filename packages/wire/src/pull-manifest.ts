import {
  maximumRemotePathCharacters,
  parseRemotePath,
} from "@dumbridge/remote-path";
import { Result, Schema } from "effect";
import { maximumManifestEntries } from "./limits";

export const NonNegativeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0)
);
export const PathText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maximumRemotePathCharacters)
);
export const Digest = Schema.String.check(
  Schema.isLengthBetween(64, 64),
  Schema.isPattern(/^[a-f0-9]{64}$/)
);

const FileEntrySchema = Schema.Struct({
  digest: Digest,
  kind: Schema.Literal("file"),
  path: PathText,
  size: NonNegativeInt,
});
const DirectoryEntrySchema = Schema.Struct({
  kind: Schema.Literal("directory"),
  path: PathText,
});
export const PullManifestSchema = Schema.Struct({
  digestAlgorithm: Schema.Literal("sha256"),
  entries: Schema.Array(
    Schema.Union([FileEntrySchema, DirectoryEntrySchema])
  ).check(Schema.isMaxLength(maximumManifestEntries)),
  kind: Schema.Literals(["directory", "file"]),
  name: PathText,
  totalBytes: NonNegativeInt,
});

export type PullManifest = typeof PullManifestSchema.Type;
export type PullManifestEntry = PullManifest["entries"][number];
export type PullFileEntry = Extract<
  PullManifestEntry,
  { readonly kind: "file" }
>;

export interface PullManifestLimits {
  readonly maxFileBytes: number;
  readonly maxManifestEntries: number;
  readonly maxTransferBytes: number;
}

export type PullManifestViolation =
  | { readonly kind: "entry-path"; readonly path: string }
  | { readonly kind: "file-shape" }
  | {
      readonly kind: "limit";
      readonly limit: "file-bytes" | "manifest-entries" | "transfer-bytes";
      readonly maximum: number;
      readonly observed: number;
    }
  | { readonly kind: "name"; readonly path: string }
  | { readonly kind: "order"; readonly path: string }
  | { readonly kind: "parents"; readonly path: string }
  | { readonly kind: "shape" }
  | {
      readonly kind: "totals";
      readonly computed: number;
      readonly declared: number;
    };

export interface ValidatedPullManifest {
  readonly files: readonly PullFileEntry[];
  readonly manifest: PullManifest;
}

interface ValidatedManifestEntries {
  readonly files: readonly PullFileEntry[];
  readonly totalBytes: number;
}

const parentsAreDeclared = (
  path: string,
  directories: ReadonlySet<string>
): boolean => {
  let separator = path.indexOf("/");
  while (separator !== -1) {
    if (!directories.has(path.slice(0, separator))) {
      return false;
    }
    separator = path.indexOf("/", separator + 1);
  }
  return true;
};

const validateEntries = (
  entries: PullManifest["entries"],
  limits: PullManifestLimits
): Result.Result<ValidatedManifestEntries, PullManifestViolation> => {
  const files: PullFileEntry[] = [];
  const directories = new Set<string>();
  let previousPath: string | undefined;
  let totalBytes = 0;
  for (const entry of entries) {
    if (Result.isFailure(parseRemotePath(entry.path))) {
      return Result.fail({ kind: "entry-path", path: entry.path });
    }
    if (previousPath !== undefined && previousPath >= entry.path) {
      return Result.fail({ kind: "order", path: entry.path });
    }
    previousPath = entry.path;
    if (!parentsAreDeclared(entry.path, directories)) {
      return Result.fail({ kind: "parents", path: entry.path });
    }
    if (entry.kind === "directory") {
      directories.add(entry.path);
      continue;
    }
    if (!Number.isSafeInteger(entry.size) || entry.size > limits.maxFileBytes) {
      return Result.fail({
        kind: "limit",
        limit: "file-bytes",
        maximum: limits.maxFileBytes,
        observed: entry.size,
      });
    }
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes)) {
      return Result.fail({
        kind: "limit",
        limit: "transfer-bytes",
        maximum: limits.maxTransferBytes,
        observed: Number.MAX_SAFE_INTEGER,
      });
    }
    if (totalBytes > limits.maxTransferBytes) {
      return Result.fail({
        kind: "limit",
        limit: "transfer-bytes",
        maximum: limits.maxTransferBytes,
        observed: totalBytes,
      });
    }
    files.push(entry);
  }
  return Result.succeed({ files, totalBytes });
};

export const validatePullManifest = (
  input: unknown,
  limits: PullManifestLimits
): Result.Result<ValidatedPullManifest, PullManifestViolation> => {
  const decoded = Schema.decodeUnknownResult(PullManifestSchema)(input, {
    onExcessProperty: "error",
  });
  if (Result.isFailure(decoded)) {
    return Result.fail({ kind: "shape" });
  }
  const manifest = decoded.success;
  const name = parseRemotePath(manifest.name);
  if (Result.isFailure(name) || name.success.segments.length !== 1) {
    return Result.fail({ kind: "name", path: manifest.name });
  }
  if (manifest.entries.length > limits.maxManifestEntries) {
    return Result.fail({
      kind: "limit",
      limit: "manifest-entries",
      maximum: limits.maxManifestEntries,
      observed: manifest.entries.length,
    });
  }

  const entries = validateEntries(manifest.entries, limits);
  if (Result.isFailure(entries)) {
    return Result.fail(entries.failure);
  }

  if (manifest.totalBytes !== entries.success.totalBytes) {
    return Result.fail({
      computed: entries.success.totalBytes,
      declared: manifest.totalBytes,
      kind: "totals",
    });
  }
  if (
    manifest.kind === "file" &&
    (manifest.entries.length !== 1 ||
      manifest.entries[0]?.kind !== "file" ||
      manifest.entries[0].path !== manifest.name)
  ) {
    return Result.fail({ kind: "file-shape" });
  }

  return Result.succeed({ files: entries.success.files, manifest });
};
