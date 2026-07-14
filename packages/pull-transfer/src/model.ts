import { parseRemotePath } from "@dumbridge/remote-path";
import {
  maximumFileBytes,
  maximumManifestEntries,
  maximumTransferBytes,
  type PullFileEntry,
  type PullManifest,
  type PullManifestViolation,
  validatePullManifest,
} from "@dumbridge/wire";
import { type Effect, Result, type Stream } from "effect";
import {
  type PullError,
  PullIntegrityError,
  PullLimitError,
  PullPathError,
} from "./errors";

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
  maxEntries: maximumManifestEntries,
  maxFileBytes: maximumFileBytes,
  maxTotalBytes: maximumTransferBytes,
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
): Result.Result<string, PullPathError> => {
  const parsed = parseRemotePath(remotePath);
  if (Result.isFailure(parsed)) {
    return Result.fail(
      new PullPathError({
        path: remotePath,
        reason: "path must be canonical and relative",
      })
    );
  }
  if (destination !== undefined) {
    return Result.succeed(destination);
  }

  const name = parsed.success.segments.at(-1);
  if (name === undefined) {
    return Result.fail(
      new PullPathError({
        path: remotePath,
        reason: "path has no file name",
      })
    );
  }
  return Result.succeed(`./${name}`);
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

const receiverLimitNames = {
  "file-bytes": "file bytes",
  "manifest-entries": "entries",
  "transfer-bytes": "total bytes",
} as const;

const manifestViolationError = (
  violation: PullManifestViolation
): PullError => {
  switch (violation.kind) {
    case "entry-path":
    case "name":
      return new PullPathError({
        path: violation.path,
        reason: "path must be canonical and relative",
      });
    case "limit":
      return new PullLimitError({
        limit: receiverLimitNames[violation.limit],
        maximum: violation.maximum,
        observed: violation.observed,
      });
    case "order":
      return new PullIntegrityError({
        actual: violation.path,
        expected: "unique entries in lexical order",
        path: "manifest",
      });
    case "parents":
      return new PullIntegrityError({
        actual: violation.path,
        expected: "declared parent directories",
        path: "manifest",
      });
    case "totals":
      return new PullIntegrityError({
        actual: String(violation.declared),
        expected: String(violation.computed),
        path: "manifest",
      });
    case "file-shape":
      return new PullIntegrityError({
        actual: "invalid file manifest",
        expected: "one named file entry",
        path: "manifest",
      });
    default:
      return new PullIntegrityError({
        actual: "invalid manifest",
        expected: "valid manifest",
        path: "manifest",
      });
  }
};

export const manifestFrom = (
  input: unknown,
  limits: PullLimits
): PullManifest => {
  const validated = validatePullManifest(input, {
    maxFileBytes: limits.maxFileBytes,
    maxManifestEntries: limits.maxEntries,
    maxTransferBytes: limits.maxTotalBytes,
  });
  if (Result.isFailure(validated)) {
    throw manifestViolationError(validated.failure);
  }
  return validated.success.manifest;
};
