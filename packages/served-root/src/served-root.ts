import { lstatSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { Effect } from "effect";
import {
  InvalidServedRootError,
  ServedRootChangedError,
  servedRootChanged,
} from "./errors";
import {
  hostSegmentsFrom,
  identitiesMatch,
  identityFrom,
  inspectDirectory,
  isMissingPath,
  type PathComponentSnapshot,
  pathKindFrom,
  pathSnapshotsMatch,
  type ServedRootIdentity,
  type VirtualPathSnapshot,
  virtualRoot,
} from "./host-paths";
import { PullView, type ServedRootPullView } from "./pull-view";
import {
  fileSystemFacade,
  RequestBudgetOverlayFs,
  type ServedRootReadLimits,
  type ServedRootReadView,
} from "./read-view";
import type { SourceFileExpectation, SourceRevision } from "./source-revision";

const maximumDisplayNameCharacters = 64;

// The sanitized display is the only part of the host path allowed to leave
// this module: the final component the sharer chose, stripped of terminal
// control characters and bounded, so no message can echo the raw host path.
const displayNameFrom = (hostPath: string) => {
  const name = basename(hostPath)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point of this sanitizer
    .replaceAll(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .slice(0, maximumDisplayNameCharacters)
    .trim();
  return name.length === 0 ? "served-root" : name;
};

export class ServedRoot {
  readonly displayName: string;
  readonly #hostPath: string;
  readonly #identity: ServedRootIdentity;

  private constructor(hostPath: string, identity: ServedRootIdentity) {
    this.displayName = displayNameFrom(hostPath);
    this.#hostPath = hostPath;
    this.#identity = identity;
  }

  #assertCurrent() {
    try {
      const stats = inspectDirectory(this.#hostPath);
      const currentPath = realpathSync(this.#hostPath);
      if (
        currentPath !== this.#hostPath ||
        !identitiesMatch(this.#identity, identityFrom(stats))
      ) {
        throw new Error("served root identity changed");
      }
    } catch {
      // biome-ignore lint/style/useErrorCause: The cause may expose a host path.
      throw servedRootChanged();
    }
  }

  #snapshotVirtualPath(virtualPath: string): VirtualPathSnapshot {
    const segments = hostSegmentsFrom(virtualPath);
    if (segments === undefined) {
      return;
    }
    const snapshot: PathComponentSnapshot[] = [];
    let hostPath = this.#hostPath;
    for (const segment of segments) {
      hostPath = join(hostPath, segment);
      try {
        const stats = lstatSync(hostPath);
        snapshot.push({
          identity: identityFrom(stats),
          kind: pathKindFrom(stats),
          state: "present",
        });
        if (stats.isSymbolicLink()) {
          break;
        }
      } catch (cause) {
        if (isMissingPath(cause)) {
          snapshot.push({ state: "missing" });
          break;
        }
        throw servedRootChanged();
      }
    }
    return snapshot;
  }

  #snapshotVirtualPaths(paths: readonly string[]) {
    return [...new Set(paths)].map((path) => this.#snapshotVirtualPath(path));
  }

  #assertBoundaryUnchanged(
    paths: readonly string[],
    expected: readonly VirtualPathSnapshot[]
  ) {
    this.#assertCurrent();
    for (const [index, virtualPath] of paths.entries()) {
      if (
        !pathSnapshotsMatch(
          expected[index],
          this.#snapshotVirtualPath(virtualPath)
        )
      ) {
        throw servedRootChanged();
      }
    }
  }

  async #guardPaths<A>(
    paths: readonly string[],
    operation: () => Promise<A>
  ): Promise<A> {
    this.#assertCurrent();
    const guardedPaths = [...new Set(paths)];
    const expected = this.#snapshotVirtualPaths(guardedPaths);
    try {
      const result = await operation();
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      return result;
    } catch (cause) {
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      throw cause;
    }
  }

  async #guardPathResource<A>(
    paths: readonly string[],
    acquire: () => Promise<A>,
    release: (resource: A) => Promise<void>
  ): Promise<A> {
    this.#assertCurrent();
    const guardedPaths = [...new Set(paths)];
    const expected = this.#snapshotVirtualPaths(guardedPaths);
    let acquired = false;
    let resource: A | undefined;
    try {
      resource = await acquire();
      acquired = true;
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      return resource;
    } catch (cause) {
      let releaseCause: unknown;
      if (acquired) {
        try {
          await release(resource as A);
        } catch (error) {
          releaseCause = error;
        }
      }
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      if (releaseCause !== undefined) {
        throw releaseCause;
      }
      throw cause;
    }
  }

  #guardPathsSync<A>(paths: readonly string[], operation: () => A): A {
    this.#assertCurrent();
    const guardedPaths = [...new Set(paths)];
    const expected = this.#snapshotVirtualPaths(guardedPaths);
    try {
      const result = operation();
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      return result;
    } catch (cause) {
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      throw cause;
    }
  }

  #assertObservedPaths(paths: readonly string[]) {
    for (const virtualPath of paths) {
      this.#assertObservedPath(virtualPath);
    }
  }

  // A symlink as the final component is only reported, never followed, but a
  // symlinked earlier component would re-route every path below it.
  #assertObservedPath(virtualPath: string) {
    const segments = hostSegmentsFrom(virtualPath);
    if (segments === undefined) {
      return;
    }
    let hostPath = this.#hostPath;
    for (const [index, segment] of segments.entries()) {
      hostPath = join(hostPath, segment);
      try {
        const stats = lstatSync(hostPath);
        if (stats.isSymbolicLink() && index < segments.length - 1) {
          throw servedRootChanged();
        }
      } catch (cause) {
        if (cause instanceof ServedRootChangedError) {
          throw cause;
        }
        if (isMissingPath(cause)) {
          break;
        }
        throw servedRootChanged();
      }
    }
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
      catch: servedRootChanged,
      try: () => this.verifySync(),
    })
  );

  // The pull planner is a promise engine; it must verify the root identity
  // without re-entering an Effect runtime from inside a running fiber.
  readonly verifySync = (): void => {
    this.#assertCurrent();
  };

  readonly openPullView = () =>
    this.#guardPathsSync([], () => {
      const view = new PullView(
        this.#hostPath,
        (paths, operation) => this.#guardPaths(paths, operation),
        (paths, acquire, release) =>
          this.#guardPathResource(paths, acquire, release)
      );
      return Object.freeze({
        inspect: (
          path: string,
          options: { readonly expected?: SourceRevision },
          signal: AbortSignal
        ) => view.inspect(path, options, signal),
        list: (
          path: string,
          options: {
            readonly expected?: SourceRevision;
            readonly reserve: () => void;
          },
          signal: AbortSignal
        ) => view.list(path, options, signal),
        scan: (options: {
          readonly chunkBytes: number;
          readonly expected?: SourceFileExpectation;
          readonly maxFileBytes: number;
          readonly path: string;
          readonly signal: AbortSignal;
        }) => view.scan(options),
      } satisfies ServedRootPullView);
    });

  readonly openReadView = (limits: ServedRootReadLimits) =>
    this.#guardPathsSync([], () => {
      const fileSystem = new RequestBudgetOverlayFs(
        this.#hostPath,
        limits,
        (paths, operation) => this.#guardPaths(paths, operation),
        (paths, operation) => this.#guardPathsSync(paths, operation),
        (paths) => this.#assertObservedPaths(paths)
      );
      return Object.freeze({
        begin: (signal: AbortSignal) => fileSystem.begin(signal),
        fileSystem: fileSystemFacade(fileSystem),
        get limitExceeded() {
          return fileSystem.limitExceeded;
        },
        get outsideRootPath() {
          return fileSystem.outsideRootPath;
        },
        get sourceFailure() {
          return fileSystem.sourceFailure;
        },
        workingDirectory: virtualRoot,
      } satisfies ServedRootReadView);
    });
}
