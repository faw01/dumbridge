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

const servedRootChanged = () =>
  new ServedRootChangedError({
    message: "served root changed after bridge start",
  });

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

  private assertCurrent() {
    try {
      const stats = inspectDirectory(this.path);
      const currentPath = realpathSync(this.path);
      if (
        currentPath !== this.path ||
        !identitiesMatch(this.identity, identityFrom(stats))
      ) {
        throw new Error("served root identity changed");
      }
    } catch {
      // biome-ignore lint/style/useErrorCause: The cause may expose a host path.
      throw servedRootChanged();
    }
  }

  readonly guard = async <A>(operation: () => Promise<A>): Promise<A> => {
    this.assertCurrent();
    try {
      const result = await operation();
      this.assertCurrent();
      return result;
    } catch (cause) {
      this.assertCurrent();
      throw cause;
    }
  };

  readonly guardSync = <A>(operation: () => A): A => {
    this.assertCurrent();
    try {
      const result = operation();
      this.assertCurrent();
      return result;
    } catch (cause) {
      this.assertCurrent();
      throw cause;
    }
  };

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
      catch: servedRootChanged,
      try: () => this.assertCurrent(),
    })
  );
}
