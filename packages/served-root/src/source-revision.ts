import type { Stats } from "node:fs";
import type { PathKind } from "./host-paths";

const sourceRevisionBrand: unique symbol = Symbol("SourceRevision");

export interface SourceRevision {
  readonly [sourceRevisionBrand]: true;
}

export type SourceEntry =
  | {
      readonly kind: "directory";
      readonly path: string;
      readonly revision: SourceRevision;
    }
  | {
      readonly kind: "other";
      readonly path: string;
      readonly revision: SourceRevision;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly revision: SourceRevision;
      readonly size: number;
    };

export interface SourceDirectory {
  readonly children: readonly string[];
  readonly path: string;
  readonly revision: SourceRevision;
}

export interface SourceFileExpectation {
  readonly digest: string;
  readonly revision: SourceRevision;
  readonly size: number;
}

export interface SourceFileScan {
  readonly digest: string;
  readonly revision: SourceRevision;
  readonly size: number;
}

interface SourceFingerprint {
  readonly ctimeMs: number;
  readonly device: number;
  readonly inode: number;
  readonly kind: Exclude<PathKind, "symlink">;
  readonly mtimeMs: number;
  readonly size: number;
}

const sourceRevisions = new WeakMap<SourceRevision, SourceFingerprint>();

const sourceKindFrom = (stats: Stats): Exclude<PathKind, "symlink"> => {
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  return "other";
};

const sourceFingerprintFrom = (stats: Stats): SourceFingerprint => ({
  ctimeMs: stats.ctimeMs,
  device: stats.dev,
  inode: stats.ino,
  kind: sourceKindFrom(stats),
  mtimeMs: stats.mtimeMs,
  size: stats.size,
});

const sourceRevisionFrom = (stats: Stats): SourceRevision => {
  const revision = Object.freeze({
    [sourceRevisionBrand]: true as const,
  });
  sourceRevisions.set(revision, sourceFingerprintFrom(stats));
  return revision;
};

export const sourceRevisionMatches = (
  revision: SourceRevision,
  stats: Stats
) => {
  const expected = sourceRevisions.get(revision);
  if (expected === undefined) {
    return false;
  }
  const observed = sourceFingerprintFrom(stats);
  return (
    expected.ctimeMs === observed.ctimeMs &&
    expected.device === observed.device &&
    expected.inode === observed.inode &&
    expected.kind === observed.kind &&
    expected.mtimeMs === observed.mtimeMs &&
    expected.size === observed.size
  );
};

export const sourceEntryFrom = (path: string, stats: Stats): SourceEntry => {
  const revision = sourceRevisionFrom(stats);
  if (stats.isFile()) {
    return Object.freeze({
      kind: "file",
      path,
      revision,
      size: stats.size,
    });
  }
  return Object.freeze({
    kind: sourceKindFrom(stats) === "directory" ? "directory" : "other",
    path,
    revision,
  });
};
