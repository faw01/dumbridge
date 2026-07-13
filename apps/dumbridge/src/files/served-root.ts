import { lstatSync, realpathSync, type Stats } from "node:fs";
import { Effect, Schema } from "effect";

interface ServedRootIdentity {
  readonly birthtimeMs: number;
  readonly device: number;
  readonly inode: number;
}

export class InvalidServedRootError extends Schema.TaggedErrorClass<InvalidServedRootError>()(
  "InvalidServedRootError",
  { message: Schema.String }
) {}

export class ServedRootChangedError extends Schema.TaggedErrorClass<ServedRootChangedError>()(
  "ServedRootChangedError",
  { message: Schema.String }
) {}

const identityFrom = (stats: Stats): ServedRootIdentity => ({
  birthtimeMs: stats.birthtimeMs,
  device: stats.dev,
  inode: stats.ino,
});

const identitiesMatch = (
  expected: ServedRootIdentity,
  observed: ServedRootIdentity
) =>
  expected.birthtimeMs === observed.birthtimeMs &&
  expected.device === observed.device &&
  expected.inode === observed.inode;

const inspectDirectory = (path: string) => {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("served root is not a directory");
  }
  return stats;
};

export class ServedRoot {
  readonly path: string;

  private readonly identity: ServedRootIdentity;

  private constructor(path: string, identity: ServedRootIdentity) {
    this.path = path;
    this.identity = identity;
  }

  static readonly make = Effect.fn("ServedRoot.make")((path: string) =>
    Effect.try({
      catch: () =>
        new InvalidServedRootError({
          message: "served root must be an existing directory",
        }),
      try: () => {
        const canonicalPath = realpathSync(path);
        const stats = inspectDirectory(canonicalPath);
        return new ServedRoot(canonicalPath, identityFrom(stats));
      },
    })
  );

  readonly verify = Effect.fn("ServedRoot.verify")(() =>
    Effect.try({
      catch: () =>
        new ServedRootChangedError({
          message: "served root changed after bridge start",
        }),
      try: () => {
        const stats = inspectDirectory(this.path);
        const currentPath = realpathSync(this.path);
        if (
          currentPath !== this.path ||
          !identitiesMatch(this.identity, identityFrom(stats))
        ) {
          throw new Error("served root identity changed");
        }
      },
    })
  );
}
