import { constants, lstatSync, type Stats } from "node:fs";
import { posix } from "node:path";

export const virtualRoot = "/workspace";
export const readOnlyNoFollowNonBlocking =
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags compose as a bitmask; nonblocking prevents special-file swaps from hanging before fstat.
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface ServedRootIdentity {
  readonly birthtimeMs: number;
  readonly device: number;
  readonly inode: number;
}

export type PathKind = "directory" | "file" | "other" | "symlink";

export type PathComponentSnapshot =
  | { readonly state: "missing" }
  | {
      readonly identity: ServedRootIdentity;
      readonly kind: PathKind;
      readonly state: "present";
    };

export type VirtualPathSnapshot = readonly PathComponentSnapshot[] | undefined;

export type AsyncPathGuard = <A>(
  paths: readonly string[],
  operation: () => Promise<A>
) => Promise<A>;

export type AsyncPathResourceGuard = <A>(
  paths: readonly string[],
  acquire: () => Promise<A>,
  release: (resource: A) => Promise<void>
) => Promise<A>;

export type SyncPathGuard = <A>(
  paths: readonly string[],
  operation: () => A
) => A;

export const identityFrom = (stats: Stats): ServedRootIdentity => ({
  birthtimeMs: stats.birthtimeMs,
  device: stats.dev,
  inode: stats.ino,
});

export const identitiesMatch = (
  expected: ServedRootIdentity,
  observed: ServedRootIdentity
) =>
  expected.birthtimeMs === observed.birthtimeMs &&
  expected.device === observed.device &&
  expected.inode === observed.inode;

export const pathKindFrom = (stats: Stats): PathKind => {
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

export const pathComponentsMatch = (
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

export const pathSnapshotsMatch = (
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

export const inspectDirectory = (path: string) => {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("served root is not a directory");
  }
  return stats;
};

export const isMissingPath = (cause: unknown) => {
  if (!(cause instanceof Error)) {
    return false;
  }
  const { code } = cause as NodeJS.ErrnoException;
  return code === "ENOENT" || code === "ENOTDIR";
};

export const hostSegmentsFrom = (virtualPath: string) => {
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
