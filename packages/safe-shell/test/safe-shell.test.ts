import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as hostFileSystem } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ServedRoot } from "@dumbridge/served-root";
import { Effect, Fiber } from "effect";
import { Bash } from "just-bash";
import { SafeShell, type SafeShellLimits } from "../src/index";

let fixtureRoot = "";
let servedRoot = "";
let outsideRoot = "";

const makeShell = async (limits?: Partial<SafeShellLimits>) => {
  const root = await Effect.runPromise(ServedRoot.make(servedRoot));
  return Effect.runPromise(SafeShell.make(root, limits));
};

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "dumbridge-safe-shell-"));
  servedRoot = join(fixtureRoot, "served");
  outsideRoot = join(fixtureRoot, "outside");
  await Promise.all([
    mkdir(servedRoot, { recursive: true }),
    mkdir(outsideRoot, { recursive: true }),
  ]);
});

afterEach(async () => {
  await rm(fixtureRoot, { force: true, recursive: true });
});

describe("SafeShell", () => {
  test("reads live host changes after construction", async () => {
    const shell = await makeShell();
    const path = join(servedRoot, "uncommitted.txt");

    await writeFile(path, "first\n");
    const first = await Effect.runPromise(shell.execute("cat uncommitted.txt"));

    await writeFile(path, "second\n");
    const second = await Effect.runPromise(
      shell.execute("cat uncommitted.txt")
    );

    expect(first).toMatchObject({ exitCode: 0, stdout: "first\n" });
    expect(second).toMatchObject({ exitCode: 0, stdout: "second\n" });
  });

  test("refuses a served root rebound to another directory", async () => {
    await writeFile(join(outsideRoot, "secret.txt"), "outside secret\n");
    const shell = await makeShell();
    await rename(servedRoot, join(fixtureRoot, "original-served"));
    await symlink(
      outsideRoot,
      servedRoot,
      process.platform === "win32" ? "junction" : "dir"
    );

    const error = await Effect.runPromise(
      Effect.flip(shell.execute("cat secret.txt"))
    );

    expect(error).toMatchObject({
      _tag: "ServedRootChangedError",
      message: "served root changed after bridge start",
    });
  });

  test("never returns outside content when the root changes during a read", async () => {
    await Promise.all([
      writeFile(join(servedRoot, "secret.txt"), "inside secret\n"),
      writeFile(join(outsideRoot, "secret.txt"), "outside secret\n"),
    ]);
    const shell = await makeShell();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const originalOpen = hostFileSystem.open;
    const open = spyOn(hostFileSystem, "open");
    let paused = false;
    open.mockImplementation(async (...args) => {
      if (!paused && basename(String(args[0])) === "secret.txt") {
        paused = true;
        entered.resolve();
        await resume.promise;
      }
      return originalOpen(...args);
    });
    const outcomePromise = Effect.runPromise(
      shell.execute("cat secret.txt")
    ).then(
      (result) => ({ result, type: "success" as const }),
      (error: unknown) => ({ error, type: "failure" as const })
    );

    const { outcome, secretOpens } = await (async () => {
      try {
        await entered.promise;
        await rename(servedRoot, join(fixtureRoot, "original-served"));
        await symlink(
          outsideRoot,
          servedRoot,
          process.platform === "win32" ? "junction" : "dir"
        );
        resume.resolve();

        const completedOutcome = await outcomePromise;
        return {
          outcome: completedOutcome,
          secretOpens: open.mock.calls.filter(
            ([path]) => basename(String(path)) === "secret.txt"
          ),
        };
      } finally {
        resume.resolve();
        await outcomePromise;
        open.mockRestore();
      }
    })();

    expect(outcome).toMatchObject({
      error: {
        _tag: "ServedRootChangedError",
        message: "served root changed after bridge start",
      },
      type: "failure",
    });
    expect(secretOpens).toHaveLength(1);
    expect(JSON.stringify(outcome)).not.toContain("outside secret");
    expect(JSON.stringify(outcome)).not.toContain(outsideRoot);
  });

  test("never returns outside content when a nested directory changes during a read", async () => {
    const directory = join(servedRoot, "dir");
    await mkdir(directory);
    await Promise.all([
      writeFile(join(directory, "secret.txt"), "inside secret\n"),
      writeFile(join(outsideRoot, "secret.txt"), "outside secret\n"),
    ]);
    const shell = await makeShell();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const originalOpen = hostFileSystem.open;
    const open = spyOn(hostFileSystem, "open");
    let paused = false;
    open.mockImplementation(async (...args) => {
      if (!paused && basename(String(args[0])) === "secret.txt") {
        paused = true;
        entered.resolve();
        await resume.promise;
      }
      return originalOpen(...args);
    });
    const outcomePromise = Effect.runPromise(
      shell.execute("cat dir/secret.txt; cat dir/secret.txt")
    ).then(
      (result) => ({ result, type: "success" as const }),
      (error: unknown) => ({ error, type: "failure" as const })
    );

    const { outcome, secretOpens } = await (async () => {
      try {
        await entered.promise;
        await rename(directory, join(servedRoot, "original-dir"));
        await symlink(
          outsideRoot,
          directory,
          process.platform === "win32" ? "junction" : "dir"
        );
        resume.resolve();

        const completedOutcome = await outcomePromise;
        return {
          outcome: completedOutcome,
          secretOpens: open.mock.calls.filter(
            ([path]) => basename(String(path)) === "secret.txt"
          ),
        };
      } finally {
        resume.resolve();
        await outcomePromise;
        open.mockRestore();
      }
    })();

    expect(outcome).toMatchObject({
      error: {
        _tag: "ServedRootChangedError",
        message: "served root changed after bridge start",
      },
      type: "failure",
    });
    expect(secretOpens).toHaveLength(1);
    expect(JSON.stringify(outcome)).not.toContain("outside secret");
    expect(JSON.stringify(outcome)).not.toContain(outsideRoot);
  });

  test("never returns partial content when a host file shrinks during a read", async () => {
    const path = join(servedRoot, "changing.txt");
    await writeFile(path, "inside secret\n");
    const shell = await makeShell();
    const originalOpen = hostFileSystem.open;
    const open = spyOn(hostFileSystem, "open");
    open.mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (basename(String(args[0])) !== "changing.txt") {
        return handle;
      }
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read") {
            return async (buffer: Uint8Array) => ({ buffer, bytesRead: 0 });
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });

    try {
      const outcome = await Effect.runPromise(
        shell.execute("printf before; cat changing.txt; printf after")
      ).then(
        (result) => ({ result, type: "success" as const }),
        (error: unknown) => ({ error, type: "failure" as const })
      );

      expect(outcome).toMatchObject({
        error: {
          _tag: "ServedRootSourceChangedError",
          path: "/workspace/changing.txt",
        },
        type: "failure",
      });
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain("before");
      expect(serialized).not.toContain("after");
      expect(serialized).not.toContain("inside secret");
      expect(serialized).not.toContain(servedRoot);
    } finally {
      open.mockRestore();
    }
  });

  test("discards redirection, rm, and mv writes after each execution", async () => {
    await Promise.all([
      writeFile(join(servedRoot, "note.txt"), "host note\n"),
      writeFile(join(servedRoot, "keep.txt"), "host keep\n"),
    ]);
    const shell = await makeShell();

    const changed = await Effect.runPromise(
      shell.execute(
        'printf "overlay note\\n" > note.txt; rm keep.txt; mv note.txt moved.txt; cat moved.txt'
      )
    );

    expect(changed).toMatchObject({ exitCode: 0, stdout: "overlay note\n" });
    expect(await readFile(join(servedRoot, "note.txt"), "utf8")).toBe(
      "host note\n"
    );
    expect(await readFile(join(servedRoot, "keep.txt"), "utf8")).toBe(
      "host keep\n"
    );
    await expect(access(join(servedRoot, "moved.txt"))).rejects.toThrow();

    const fresh = await Effect.runPromise(
      shell.execute("cat note.txt; cat keep.txt")
    );
    expect(fresh).toMatchObject({
      exitCode: 0,
      stdout: "host note\nhost keep\n",
    });
  });

  test("supports familiar read-side exploration", async () => {
    const skillDirectory = join(servedRoot, ".agents", "skills", "effect");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "# Effect\nUse Effect.Service for deep modules.\n"
    );
    const shell = await makeShell();

    const result = await Effect.runPromise(
      shell.execute(
        "find . -path '*/SKILL.md' -print | sort; rg -n 'Effect.Service' .agents | head -5; sed -n '1,2p' .agents/skills/effect/SKILL.md"
      )
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("./.agents/skills/effect/SKILL.md");
    expect(result.stdout).toContain("Effect.Service");
    expect(result.stdout).toContain("# Effect\n");
  });

  test("blocks traversal, absolute paths, and symlink escape", async () => {
    const outsideFile = join(outsideRoot, "secret.txt");
    await writeFile(outsideFile, "outside secret\n");
    await symlink(outsideRoot, join(servedRoot, "escape"), "junction");
    const shell = await makeShell();
    const portableOutsideFile = outsideFile.replaceAll("\\", "/");
    const absolutePath = portableOutsideFile.startsWith("/")
      ? portableOutsideFile
      : `/${portableOutsideFile}`;

    const [traversal, backslashTraversal, absolute, linked] = await Promise.all(
      [
        Effect.runPromise(shell.execute("cat ../outside/secret.txt")),
        Effect.runPromise(shell.execute("cat '..\\outside\\secret.txt'")),
        Effect.runPromise(shell.execute(`cat '${absolutePath}'`)),
        Effect.runPromise(shell.execute("cat escape/secret.txt")),
      ]
    );

    for (const result of [traversal, backslashTraversal, absolute, linked]) {
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("outside secret");
    }
    for (const result of [traversal, backslashTraversal, linked]) {
      expect(result.stderr).not.toContain(fixtureRoot);
    }
  });

  test("does not expose host, network, Python, or JavaScript commands", async () => {
    const shell = await makeShell();

    const result = await Effect.runPromise(
      shell.execute(
        "git; bash; sh; env; printenv; curl; python3; node; js-exec"
      )
    );

    expect(result.exitCode).toBe(127);
    for (const command of [
      "git",
      "bash",
      "sh",
      "env",
      "printenv",
      "curl",
      "node",
      "js-exec",
    ]) {
      expect(result.stderr).toContain(`${command}: command not found`);
    }
    expect(result.stderr).toContain("python3: command not available");
  });

  test("keeps concurrent Effect fibers compatible and isolated", async () => {
    const shell = await makeShell();

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        Effect.runPromise(shell.execute(`echo request-${index}`))
      )
    );

    expect(results.map(({ stdout }) => stdout)).toEqual([
      "request-0\n",
      "request-1\n",
      "request-2\n",
      "request-3\n",
      "request-4\n",
      "request-5\n",
      "request-6\n",
      "request-7\n",
    ]);
  });

  test("interrupts runaway scripts and remains usable", async () => {
    await writeFile(join(servedRoot, "tick.txt"), "tick\n");
    const shell = await makeShell({
      maxCommandCount: Number.MAX_SAFE_INTEGER,
      maxFileReadBytes: Number.MAX_SAFE_INTEGER,
      maxLoopIterations: Number.MAX_SAFE_INTEGER,
    });
    const fiber = Effect.runFork(
      shell.execute("while true; do cat tick.txt > /dev/null; done")
    );
    await Bun.sleep(5);

    await Effect.runPromise(
      Fiber.interrupt(fiber).pipe(Effect.timeout("1 second"))
    );
    const next = await Effect.runPromise(shell.execute("echo still-usable"));

    expect(next).toMatchObject({ exitCode: 0, stdout: "still-usable\n" });
  });

  test("does not infer typed failures from shell-controlled stderr", async () => {
    const shell = await makeShell();

    const [ordinary, explicitLimitExit] = await Promise.all([
      Effect.runPromise(shell.execute("echo file too large >&2")),
      Effect.runPromise(shell.execute("echo command >&2; exit 126")),
    ]);

    expect(ordinary).toMatchObject({
      exitCode: 0,
      stderr: "file too large\n",
    });
    expect(explicitLimitExit).toMatchObject({
      exitCode: 126,
      stderr: "command\n",
    });
  });

  test("fails closed when script, command, loop, output, or file limits are exceeded", async () => {
    await writeFile(join(servedRoot, "large.txt"), "0123456789");

    const typedCases = [
      {
        effect: (await makeShell({ maxScriptBytes: 8 })).execute(
          "echo too long"
        ),
        limit: "script",
      },
      {
        effect: (await makeShell({ maxOutputBytes: 32 })).execute("seq 1 100"),
        limit: "output",
      },
      {
        effect: (await makeShell({ maxFileReadBytes: 8 })).execute(
          "cat large.txt"
        ),
        limit: "file-read",
      },
    ] as const;

    const [typedFailures, commandLimit, loopLimit] = await Promise.all([
      Promise.all(
        typedCases.map(async (item) => ({
          error: await Effect.runPromise(Effect.flip(item.effect)),
          limit: item.limit,
        }))
      ),
      Effect.runPromise(
        (await makeShell({ maxCommandCount: 3 })).execute(
          "true; true; true; true"
        )
      ),
      Effect.runPromise(
        (await makeShell({ maxLoopIterations: 5 })).execute(
          "while true; do true; done"
        )
      ),
    ]);

    for (const failure of typedFailures) {
      const { error, limit } = failure;
      expect(error).toMatchObject({
        _tag: "ShellLimitExceededError",
        limit,
      });
    }
    for (const result of [commandLimit, loopLimit]) {
      expect(result).toMatchObject({
        exitCode: 126,
        stdout: "",
      });
    }
  });

  test("keeps a typed limit when Just Bash rejects after a filesystem cap", async () => {
    const execute = spyOn(Bash.prototype, "exec");
    execute.mockImplementation(async function (this: Bash) {
      await this.fs.writeFile("/workspace/overlay.txt", "12345678");
      try {
        await this.fs.readFileBuffer("/workspace/overlay.txt");
      } catch {
        // Simulate Just Bash replacing the filesystem error while unwinding.
      }
      throw new Error("EFBIG: simulated Just Bash rejection");
    });

    try {
      const shell = await makeShell({
        maxFileReadBytes: 4,
        maxOverlayBytes: 16,
      });
      const error = await Effect.runPromise(
        Effect.flip(shell.execute("cat overlay.txt"))
      );

      expect(error).toMatchObject({
        _tag: "ShellLimitExceededError",
        limit: "file-read",
      });
    } finally {
      execute.mockRestore();
    }
  });

  test("caps aggregate reads and overlay writes for one request", async () => {
    await Promise.all([
      writeFile(join(servedRoot, "a.txt"), "12345678"),
      writeFile(join(servedRoot, "b.txt"), "abcdefgh"),
    ]);
    const shell = await makeShell({
      maxFileReadBytes: 8,
      maxOverlayBytes: 8,
    });

    const [readError, overlayError] = await Promise.all([
      Effect.runPromise(Effect.flip(shell.execute("sha256sum a.txt b.txt"))),
      Effect.runPromise(
        Effect.flip(
          shell.execute(
            "printf 12345678 > first.txt; printf abcdefgh > second.txt"
          )
        )
      ),
    ]);

    expect(readError).toMatchObject({
      _tag: "ShellLimitExceededError",
      limit: "file-read",
    });
    expect(overlayError).toMatchObject({
      _tag: "ShellLimitExceededError",
      limit: "overlay",
    });
  });

  test("stops host reads after the aggregate read budget is exhausted", async () => {
    await Promise.all([
      writeFile(join(servedRoot, "a.txt"), "12345678"),
      writeFile(join(servedRoot, "b.txt"), "abcdefgh"),
      writeFile(join(servedRoot, "c.txt"), "ABCDEFGH"),
    ]);
    const shell = await makeShell({ maxFileReadBytes: 8 });
    const open = spyOn(hostFileSystem, "open");
    let openedFixtureFiles: string[] = [];
    let error: unknown;
    try {
      error = await Effect.runPromise(
        Effect.flip(shell.execute("cat a.txt; cat b.txt; cat c.txt"))
      );
      openedFixtureFiles = open.mock.calls
        .map(([path]) => basename(String(path)))
        .filter((path) => ["a.txt", "b.txt", "c.txt"].includes(path));
    } finally {
      open.mockRestore();
    }

    expect(error).toMatchObject({
      _tag: "ShellLimitExceededError",
      limit: "file-read",
    });
    expect(openedFixtureFiles).toEqual(["a.txt"]);
  });

  test("reserves reads before opening large or concurrent files", async () => {
    const sparsePath = join(servedRoot, "sparse.bin");
    await Promise.all([
      writeFile(join(servedRoot, "left.bin"), Buffer.alloc(256 * 1024, 1)),
      writeFile(join(servedRoot, "right.bin"), Buffer.alloc(256 * 1024, 2)),
      writeFile(sparsePath, ""),
    ]);
    await truncate(sparsePath, 64 * 1024 * 1024);
    const shell = await makeShell({ maxFileReadBytes: 256 * 1024 });

    const [fanOutError, sparseError] = await Promise.all([
      Effect.runPromise(
        Effect.flip(shell.execute("cat left.bin | cat right.bin > /dev/null"))
      ),
      Effect.runPromise(Effect.flip(shell.execute("cat sparse.bin"))),
    ]);

    for (const error of [fanOutError, sparseError]) {
      expect(error).toMatchObject({
        _tag: "ShellLimitExceededError",
        limit: "file-read",
      });
    }
  });

  test("rejects non-regular host files before reading", async () => {
    if (process.platform === "win32") {
      return;
    }
    const deviceRoot = await Effect.runPromise(ServedRoot.make("/dev"));
    const shell = await Effect.runPromise(SafeShell.make(deviceRoot));

    const result = await Effect.runPromise(shell.execute("cat null"));

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("/dev");
  });

  test("bounds zero-byte overlay entries and tombstones", async () => {
    await Promise.all(
      ["one", "two", "three", "four"].map((name) =>
        writeFile(join(servedRoot, `${name}.txt`), "host\n")
      )
    );
    const creationShell = await makeShell({ maxOverlayEntries: 3 });
    const deletionShell = await makeShell({ maxOverlayEntries: 3 });

    const [creationError, deletionError] = await Promise.all([
      Effect.runPromise(Effect.flip(creationShell.execute("touch a b c d"))),
      Effect.runPromise(
        Effect.flip(
          deletionShell.execute("rm one.txt two.txt three.txt four.txt")
        )
      ),
    ]);

    for (const error of [creationError, deletionError]) {
      expect(error).toMatchObject({
        _tag: "ShellLimitExceededError",
        limit: "overlay-entries",
      });
    }
  });

  test("keeps standard shell globs without scanning the full served tree", async () => {
    await Promise.all([
      writeFile(join(servedRoot, "a.txt"), "a\n"),
      writeFile(join(servedRoot, "b.txt"), "b\n"),
      writeFile(join(servedRoot, "c.md"), "c\n"),
    ]);
    const shell = await makeShell();

    const [expanded, quoted] = await Promise.all([
      Effect.runPromise(shell.execute("ls *.txt | sort")),
      Effect.runPromise(shell.execute("ls '*.txt'")),
    ]);

    expect(expanded.exitCode).toBe(0);
    expect(expanded.stdout.trim().split("\n")).toEqual(["a.txt", "b.txt"]);
    expect(quoted.exitCode).not.toBe(0);
  });

  test("charges an existing host file when append materializes it", async () => {
    const path = join(servedRoot, "host.txt");
    await writeFile(path, "12345678");
    const shell = await makeShell({
      maxFileReadBytes: 16,
      maxOverlayBytes: 8,
    });

    const error = await Effect.runPromise(
      Effect.flip(shell.execute("printf x >> host.txt"))
    );

    expect(error).toMatchObject({
      _tag: "ShellLimitExceededError",
      limit: "overlay",
    });
    expect(await readFile(path, "utf8")).toBe("12345678");
  });

  test("charges host files materialized by chmod and touch", async () => {
    const path = join(servedRoot, "host.txt");
    await writeFile(path, "12345678");

    const errors = await Promise.all(
      ["chmod 600 host.txt", "touch host.txt"].map(async (script) => {
        const shell = await makeShell({
          maxFileReadBytes: 16,
          maxOverlayBytes: 4,
        });
        return Effect.runPromise(Effect.flip(shell.execute(script)));
      })
    );

    for (const error of errors) {
      expect(error).toMatchObject({
        _tag: "ShellLimitExceededError",
        limit: "overlay",
      });
    }
    expect(await readFile(path, "utf8")).toBe("12345678");
  });

  test("charges host files materialized by copy and move", async () => {
    const path = join(servedRoot, "host.txt");
    await writeFile(path, "12345678");

    const errors = await Promise.all(
      ["cp host.txt copy.txt", "mv host.txt moved.txt"].map(async (script) => {
        const shell = await makeShell({
          maxFileReadBytes: 16,
          maxOverlayBytes: 4,
        });
        return Effect.runPromise(Effect.flip(shell.execute(script)));
      })
    );

    for (const error of errors) {
      expect(error).toMatchObject({
        _tag: "ShellLimitExceededError",
        limit: "overlay",
      });
    }
    expect(await readFile(path, "utf8")).toBe("12345678");
  });
});
