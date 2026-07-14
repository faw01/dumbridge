import { parseRemotePath } from "@dumbridge/remote-path";
import { Result, Schema } from "effect";
import {
  type IllegalFrameError,
  illegal,
  limitExceeded,
  type WireLimitExceededError,
  type WireSessionLimits,
} from "./errors";
import {
  PullManifestSchema,
  type WirePullFileEntry,
  type WirePullManifest,
} from "./protocol";

export interface ValidatedManifest {
  readonly files: readonly WirePullFileEntry[];
  readonly manifest: WirePullManifest;
}

interface ValidatedManifestEntries {
  readonly files: readonly WirePullFileEntry[];
  readonly totalBytes: number;
}

export const canonicalPath = (path: string, singlePart = false): boolean => {
  const parsed = parseRemotePath(path);
  return (
    Result.isSuccess(parsed) &&
    (!singlePart || parsed.success.segments.length === 1)
  );
};

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

const validateManifestEntries = (
  entries: WirePullManifest["entries"],
  limits: WireSessionLimits
): Result.Result<
  ValidatedManifestEntries,
  IllegalFrameError | WireLimitExceededError
> => {
  const files: WirePullFileEntry[] = [];
  const directories = new Set<string>();
  let previousPath: string | undefined;
  let totalBytes = 0;
  for (const entry of entries) {
    if (
      !canonicalPath(entry.path) ||
      (previousPath !== undefined && previousPath >= entry.path)
    ) {
      return Result.fail(
        illegal(
          "manifest",
          "Pull manifest paths are not canonical and ordered."
        )
      );
    }
    previousPath = entry.path;
    if (!parentsAreDeclared(entry.path, directories)) {
      return Result.fail(
        illegal("manifest", "Pull manifest omits a parent directory.")
      );
    }
    if (entry.kind === "directory") {
      directories.add(entry.path);
      continue;
    }
    if (entry.size > limits.maxFileBytes) {
      return Result.fail(
        limitExceeded("file-bytes", limits.maxFileBytes, entry.size)
      );
    }
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes)) {
      return Result.fail(
        limitExceeded(
          "transfer-bytes",
          limits.maxTransferBytes,
          Number.MAX_SAFE_INTEGER
        )
      );
    }
    if (totalBytes > limits.maxTransferBytes) {
      return Result.fail(
        limitExceeded("transfer-bytes", limits.maxTransferBytes, totalBytes)
      );
    }
    files.push(entry);
  }
  return Result.succeed({ files, totalBytes });
};

export const validateManifest = (
  input: WirePullManifest,
  limits: WireSessionLimits
): Result.Result<
  ValidatedManifest,
  IllegalFrameError | WireLimitExceededError
> => {
  const decoded = Schema.decodeUnknownResult(PullManifestSchema)(input, {
    onExcessProperty: "error",
  });
  if (Result.isFailure(decoded)) {
    return Result.fail(
      illegal("manifest", "Pull manifest does not match the wire schema.")
    );
  }
  const manifest = decoded.success;
  if (!canonicalPath(manifest.name, true)) {
    return Result.fail(
      illegal("manifest", "Pull manifest name is not canonical.")
    );
  }
  if (manifest.entries.length > limits.maxManifestEntries) {
    return Result.fail(
      limitExceeded(
        "manifest-entries",
        limits.maxManifestEntries,
        manifest.entries.length
      )
    );
  }

  const entries = validateManifestEntries(manifest.entries, limits);
  if (Result.isFailure(entries)) {
    return Result.fail(entries.failure);
  }

  if (manifest.totalBytes !== entries.success.totalBytes) {
    return Result.fail(
      illegal("manifest", "Pull manifest total does not match its files.")
    );
  }
  if (
    manifest.kind === "file" &&
    (manifest.entries.length !== 1 ||
      manifest.entries[0]?.kind !== "file" ||
      manifest.entries[0].path !== manifest.name)
  ) {
    return Result.fail(
      illegal("manifest", "File manifest does not describe one named file.")
    );
  }

  return Result.succeed({ files: entries.success.files, manifest });
};
