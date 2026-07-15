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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { Bash } from "just-bash";
import { SafeShell, type SafeShellLimits } from "../src/index";

let fixtureRoot = "";
let servedRoot = "";
let outsideRoot = "";

const makeShell = (limits?: Partial<SafeShellLimits>) =>
  ServedRoot.make(servedRoot).pipe(
    Effect.flatMap((root) => SafeShell.make(root, limits))
  );

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
  it.effect("reads live host changes after construction", () =>
    Effect.gen(function* () {
      const shell = yield* makeShell();
      const path = join(servedRoot, "uncommitted.txt");

      yield* Effect.promise(() => writeFile(path, "first\n"));
      const first = yield* shell.execute("cat uncommitted.txt");

      yield* Effect.promise(() => writeFile(path, "second\n"));
      const second = yield* shell.execute("cat uncommitted.txt");

      expect(first).toMatchObject({ exitCode: 0, stdout: "first\n" });
      expect(second).toMatchObject({ exitCode: 0, stdout: "second\n" });
    })
  );

  it.effect("refuses a served root rebound to another directory", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeFile(join(outsideRoot, "secret.txt"), "outside secret\n")
      );
      const shell = yield* makeShell();
      yield* Effect.promise(async () => {
        await rename(servedRoot, join(fixtureRoot, "original-served"));
        await symlink(
          outsideRoot,
          servedRoot,
          process.platform === "win32" ? "junction" : "dir"
        );
      });

      const error = yield* Effect.flip(shell.execute("cat secret.txt"));

      expect(error).toMatchObject({
        _tag: "ServedRootChangedError",
        message: "served root changed after bridge start",
      });
    })
  );

  it.effect(
    "never returns outside content when the root changes during a read",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all([
            writeFile(join(servedRoot, "secret.txt"), "inside secret\n"),
            writeFile(join(outsideRoot, "secret.txt"), "outside secret\n"),
          ])
        );
        const shell = yield* makeShell();
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const originalOpen = hostFileSystem.open;
        const open = vi.spyOn(hostFileSystem, "open");
        let paused = false;
        open.mockImplementation(async (...args) => {
          if (!paused && basename(String(args[0])) === "secret.txt") {
            paused = true;
            entered.resolve();
            await resume.promise;
          }
          return originalOpen(...args);
        });
        const outcomeFiber = yield* shell.execute("cat secret.txt").pipe(
          Effect.match({
            onFailure: (error) => ({ error, type: "failure" as const }),
            onSuccess: (result) => ({ result, type: "success" as const }),
          }),
          Effect.forkChild
        );

        const { outcome, secretOpens } = yield* Effect.gen(function* () {
          yield* Effect.promise(() => entered.promise);
          yield* Effect.promise(async () => {
            await rename(servedRoot, join(fixtureRoot, "original-served"));
            await symlink(
              outsideRoot,
              servedRoot,
              process.platform === "win32" ? "junction" : "dir"
            );
          });
          resume.resolve();

          const completedOutcome = yield* Fiber.join(outcomeFiber);
          return {
            outcome: completedOutcome,
            secretOpens: open.mock.calls.filter(
              ([path]) => basename(String(path)) === "secret.txt"
            ),
          };
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              resume.resolve();
              yield* Fiber.await(outcomeFiber);
              open.mockRestore();
            })
          )
        );

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
      })
  );

  it.effect(
    "never returns outside content when a nested directory changes during a read",
    () =>
      Effect.gen(function* () {
        const directory = join(servedRoot, "dir");
        yield* Effect.promise(async () => {
          await mkdir(directory);
          await Promise.all([
            writeFile(join(directory, "secret.txt"), "inside secret\n"),
            writeFile(join(outsideRoot, "secret.txt"), "outside secret\n"),
          ]);
        });
        const shell = yield* makeShell();
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const originalOpen = hostFileSystem.open;
        const open = vi.spyOn(hostFileSystem, "open");
        let paused = false;
        open.mockImplementation(async (...args) => {
          if (!paused && basename(String(args[0])) === "secret.txt") {
            paused = true;
            entered.resolve();
            await resume.promise;
          }
          return originalOpen(...args);
        });
        const outcomeFiber = yield* shell
          .execute("cat dir/secret.txt; cat dir/secret.txt")
          .pipe(
            Effect.match({
              onFailure: (error) => ({ error, type: "failure" as const }),
              onSuccess: (result) => ({ result, type: "success" as const }),
            }),
            Effect.forkChild
          );

        const { outcome, secretOpens } = yield* Effect.gen(function* () {
          yield* Effect.promise(() => entered.promise);
          yield* Effect.promise(async () => {
            await rename(directory, join(servedRoot, "original-dir"));
            await symlink(
              outsideRoot,
              directory,
              process.platform === "win32" ? "junction" : "dir"
            );
          });
          resume.resolve();

          const completedOutcome = yield* Fiber.join(outcomeFiber);
          return {
            outcome: completedOutcome,
            secretOpens: open.mock.calls.filter(
              ([path]) => basename(String(path)) === "secret.txt"
            ),
          };
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              resume.resolve();
              yield* Fiber.await(outcomeFiber);
              open.mockRestore();
            })
          )
        );

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
      })
  );

  it.effect(
    "never returns partial content when a host file shrinks during a read",
    () =>
      Effect.gen(function* () {
        const path = join(servedRoot, "changing.txt");
        yield* Effect.promise(() => writeFile(path, "inside secret\n"));
        const shell = yield* makeShell();
        const originalOpen = hostFileSystem.open;
        const open = vi.spyOn(hostFileSystem, "open");
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

        const outcome = yield* shell
          .execute("printf before; cat changing.txt; printf after")
          .pipe(
            Effect.match({
              onFailure: (error) => ({ error, type: "failure" as const }),
              onSuccess: (result) => ({ result, type: "success" as const }),
            }),
            Effect.ensuring(
              Effect.sync(() => {
                open.mockRestore();
              })
            )
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
      })
  );

  it.effect(
    "discards redirection, rm, and mv writes after each execution",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all([
            writeFile(join(servedRoot, "note.txt"), "host note\n"),
            writeFile(join(servedRoot, "keep.txt"), "host keep\n"),
          ])
        );
        const shell = yield* makeShell();

        const changed = yield* shell.execute(
          'printf "overlay note\\n" > note.txt; rm keep.txt; mv note.txt moved.txt; cat moved.txt'
        );

        expect(changed).toMatchObject({
          exitCode: 0,
          stdout: "overlay note\n",
        });
        expect(
          yield* Effect.promise(() =>
            readFile(join(servedRoot, "note.txt"), "utf8")
          )
        ).toBe("host note\n");
        expect(
          yield* Effect.promise(() =>
            readFile(join(servedRoot, "keep.txt"), "utf8")
          )
        ).toBe("host keep\n");
        yield* Effect.promise(() =>
          expect(access(join(servedRoot, "moved.txt"))).rejects.toThrow()
        );

        const fresh = yield* shell.execute("cat note.txt; cat keep.txt");
        expect(fresh).toMatchObject({
          exitCode: 0,
          stdout: "host note\nhost keep\n",
        });
      })
  );

  it.effect("supports familiar read-side exploration", () =>
    Effect.gen(function* () {
      const skillDirectory = join(servedRoot, ".agents", "skills", "effect");
      yield* Effect.promise(async () => {
        await mkdir(skillDirectory, { recursive: true });
        await writeFile(
          join(skillDirectory, "SKILL.md"),
          "# Effect\nUse Effect.Service for deep modules.\n"
        );
      });
      const shell = yield* makeShell();

      const result = yield* shell.execute(
        "find . -path '*/SKILL.md' -print | sort; rg -n 'Effect.Service' .agents | head -5; sed -n '1,2p' .agents/skills/effect/SKILL.md"
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("./.agents/skills/effect/SKILL.md");
      expect(result.stdout).toContain("Effect.Service");
      expect(result.stdout).toContain("# Effect\n");
    })
  );

  it.effect("blocks traversal, absolute paths, and symlink escape", () =>
    Effect.gen(function* () {
      const outsideFile = join(outsideRoot, "secret.txt");
      yield* Effect.promise(async () => {
        await writeFile(outsideFile, "outside secret\n");
        await symlink(outsideRoot, join(servedRoot, "escape"), "junction");
      });
      const shell = yield* makeShell();
      const portableOutsideFile = outsideFile.replaceAll("\\", "/");
      const absolutePath = portableOutsideFile.startsWith("/")
        ? portableOutsideFile
        : `/${portableOutsideFile}`;

      const [traversal, backslashTraversal, absolute, linked] =
        yield* Effect.all(
          [
            shell.execute("cat ../outside/secret.txt"),
            shell.execute("cat '..\\outside\\secret.txt'"),
            shell.execute(`cat '${absolutePath}'`),
            shell.execute("cat escape/secret.txt"),
          ],
          { concurrency: "unbounded" }
        );

      for (const result of [traversal, backslashTraversal, absolute, linked]) {
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).not.toContain("outside secret");
      }
      for (const result of [traversal, backslashTraversal, linked]) {
        expect(result.stderr).not.toContain(fixtureRoot);
      }
    })
  );

  it.effect("reports out-of-root access as outside the served root", () =>
    Effect.gen(function* () {
      const shell = yield* makeShell();

      const listed = yield* shell.execute("ls ../../Downloads");

      expect(listed.exitCode).not.toBe(0);
      expect(listed.stderr).toContain(
        "dumbridge: '/Downloads' is outside the served root; the served root is visible at /workspace.\n"
      );
      expect(listed.stderr).not.toContain(fixtureRoot);

      const concatenated = yield* shell.execute("cat /etc/passwd");

      expect(concatenated.exitCode).not.toBe(0);
      expect(concatenated.stderr).toContain(
        "dumbridge: '/etc/passwd' is outside the served root; the served root is visible at /workspace.\n"
      );
    })
  );

  it.effect(
    "does not brand misses inside the root or overlay scratch reads",
    () =>
      Effect.gen(function* () {
        const shell = yield* makeShell();

        const missingInside = yield* shell.execute("cat missing.txt");
        expect(missingInside.exitCode).not.toBe(0);
        expect(missingInside.stderr).not.toContain("outside the served root");

        const scratch = yield* shell.execute("echo hi > /tmp/f && cat /tmp/f");
        expect(scratch).toMatchObject({ exitCode: 0, stdout: "hi\n" });
        expect(scratch.stderr).not.toContain("outside the served root");
      })
  );

  it.effect(
    "does not expose host, network, Python, or JavaScript commands",
    () =>
      Effect.gen(function* () {
        const shell = yield* makeShell();

        const result = yield* shell.execute(
          "git; bash; sh; env; printenv; curl; python3; node; js-exec"
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
      })
  );

  it.effect("keeps concurrent Effect fibers compatible and isolated", () =>
    Effect.gen(function* () {
      const shell = yield* makeShell();

      const results = yield* Effect.all(
        Array.from({ length: 8 }, (_, index) =>
          shell.execute(`echo request-${index}`)
        ),
        { concurrency: "unbounded" }
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
    })
  );

  it.live("interrupts runaway scripts and remains usable", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeFile(join(servedRoot, "tick.txt"), "tick\n")
      );
      const shell = yield* makeShell({
        maxCommandCount: Number.MAX_SAFE_INTEGER,
        maxFileReadBytes: Number.MAX_SAFE_INTEGER,
        maxLoopIterations: Number.MAX_SAFE_INTEGER,
      });
      const fiber = yield* shell
        .execute("while true; do cat tick.txt > /dev/null; done")
        .pipe(Effect.forkChild);
      yield* Effect.sleep("5 millis");

      yield* Fiber.interrupt(fiber).pipe(Effect.timeout("1 second"));
      const next = yield* shell.execute("echo still-usable");

      expect(next).toMatchObject({ exitCode: 0, stdout: "still-usable\n" });
    })
  );

  it.effect("does not infer typed failures from shell-controlled stderr", () =>
    Effect.gen(function* () {
      const shell = yield* makeShell();

      const [ordinary, explicitLimitExit] = yield* Effect.all(
        [
          shell.execute("echo file too large >&2"),
          shell.execute("echo command >&2; exit 126"),
        ],
        { concurrency: "unbounded" }
      );

      expect(ordinary).toMatchObject({
        exitCode: 0,
        stderr: "file too large\n",
      });
      expect(explicitLimitExit).toMatchObject({
        exitCode: 126,
        stderr: "command\n",
      });
    })
  );

  it.effect(
    "fails closed when script, command, loop, output, or file limits are exceeded",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(join(servedRoot, "large.txt"), "0123456789")
        );

        const scriptShell = yield* makeShell({ maxScriptBytes: 8 });
        const outputShell = yield* makeShell({ maxOutputBytes: 32 });
        const fileReadShell = yield* makeShell({ maxFileReadBytes: 8 });
        const commandShell = yield* makeShell({ maxCommandCount: 3 });
        const loopShell = yield* makeShell({ maxLoopIterations: 5 });
        const typedCases = [
          { effect: scriptShell.execute("echo too long"), limit: "script" },
          { effect: outputShell.execute("seq 1 100"), limit: "output" },
          {
            effect: fileReadShell.execute("cat large.txt"),
            limit: "file-read",
          },
        ] as const;

        const [typedFailures, commandLimit, loopLimit] = yield* Effect.all(
          [
            Effect.all(
              typedCases.map((item) =>
                Effect.flip(item.effect).pipe(
                  Effect.map((error) => ({ error, limit: item.limit }))
                )
              ),
              { concurrency: "unbounded" }
            ),
            commandShell.execute("true; true; true; true"),
            loopShell.execute("while true; do true; done"),
          ],
          { concurrency: "unbounded" }
        );

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
      })
  );

  it.effect(
    "keeps a typed limit when Just Bash rejects after a filesystem cap",
    () =>
      Effect.gen(function* () {
        const execute = vi.spyOn(Bash.prototype, "exec");
        execute.mockImplementation(async function (this: Bash) {
          await this.fs.writeFile("/workspace/overlay.txt", "12345678");
          try {
            await this.fs.readFileBuffer("/workspace/overlay.txt");
          } catch {
            // Simulate Just Bash replacing the filesystem error while unwinding.
          }
          throw new Error("EFBIG: simulated Just Bash rejection");
        });

        const error = yield* Effect.gen(function* () {
          const shell = yield* makeShell({
            maxFileReadBytes: 4,
            maxOverlayBytes: 16,
          });
          return yield* Effect.flip(shell.execute("cat overlay.txt"));
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              execute.mockRestore();
            })
          )
        );

        expect(error).toMatchObject({
          _tag: "ShellLimitExceededError",
          limit: "file-read",
        });
      })
  );

  it.effect("caps aggregate reads and overlay writes for one request", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        Promise.all([
          writeFile(join(servedRoot, "a.txt"), "12345678"),
          writeFile(join(servedRoot, "b.txt"), "abcdefgh"),
        ])
      );
      const shell = yield* makeShell({
        maxFileReadBytes: 8,
        maxOverlayBytes: 8,
      });

      const [readError, overlayError] = yield* Effect.all(
        [
          Effect.flip(shell.execute("sha256sum a.txt b.txt")),
          Effect.flip(
            shell.execute(
              "printf 12345678 > first.txt; printf abcdefgh > second.txt"
            )
          ),
        ],
        { concurrency: "unbounded" }
      );

      expect(readError).toMatchObject({
        _tag: "ShellLimitExceededError",
        limit: "file-read",
      });
      expect(overlayError).toMatchObject({
        _tag: "ShellLimitExceededError",
        limit: "overlay",
      });
    })
  );

  it.effect(
    "stops host reads after the aggregate read budget is exhausted",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all([
            writeFile(join(servedRoot, "a.txt"), "12345678"),
            writeFile(join(servedRoot, "b.txt"), "abcdefgh"),
            writeFile(join(servedRoot, "c.txt"), "ABCDEFGH"),
          ])
        );
        const shell = yield* makeShell({ maxFileReadBytes: 8 });
        const open = vi.spyOn(hostFileSystem, "open");
        const { error, openedFixtureFiles } = yield* Effect.flip(
          shell.execute("cat a.txt; cat b.txt; cat c.txt")
        ).pipe(
          Effect.map((flipped) => ({
            error: flipped as unknown,
            openedFixtureFiles: open.mock.calls
              .map(([path]) => basename(String(path)))
              .filter((path) => ["a.txt", "b.txt", "c.txt"].includes(path)),
          })),
          Effect.ensuring(
            Effect.sync(() => {
              open.mockRestore();
            })
          )
        );

        expect(error).toMatchObject({
          _tag: "ShellLimitExceededError",
          limit: "file-read",
        });
        expect(openedFixtureFiles).toEqual(["a.txt"]);
      })
  );

  it.effect("reserves reads before opening large or concurrent files", () =>
    Effect.gen(function* () {
      const sparsePath = join(servedRoot, "sparse.bin");
      yield* Effect.promise(async () => {
        await Promise.all([
          writeFile(join(servedRoot, "left.bin"), Buffer.alloc(256 * 1024, 1)),
          writeFile(join(servedRoot, "right.bin"), Buffer.alloc(256 * 1024, 2)),
          writeFile(sparsePath, ""),
        ]);
        await truncate(sparsePath, 64 * 1024 * 1024);
      });
      const shell = yield* makeShell({ maxFileReadBytes: 256 * 1024 });

      const [fanOutError, sparseError] = yield* Effect.all(
        [
          Effect.flip(
            shell.execute("cat left.bin | cat right.bin > /dev/null")
          ),
          Effect.flip(shell.execute("cat sparse.bin")),
        ],
        { concurrency: "unbounded" }
      );

      for (const error of [fanOutError, sparseError]) {
        expect(error).toMatchObject({
          _tag: "ShellLimitExceededError",
          limit: "file-read",
        });
      }
    })
  );

  it.effect("rejects non-regular host files before reading", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") {
        return;
      }
      const deviceRoot = yield* ServedRoot.make("/dev");
      const shell = yield* SafeShell.make(deviceRoot);

      const result = yield* shell.execute("cat null");

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("/dev");
    })
  );

  it.effect("bounds zero-byte overlay entries and tombstones", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        Promise.all(
          ["one", "two", "three", "four"].map((name) =>
            writeFile(join(servedRoot, `${name}.txt`), "host\n")
          )
        )
      );
      const creationShell = yield* makeShell({ maxOverlayEntries: 3 });
      const deletionShell = yield* makeShell({ maxOverlayEntries: 3 });

      const [creationError, deletionError] = yield* Effect.all(
        [
          Effect.flip(creationShell.execute("touch a b c d")),
          Effect.flip(
            deletionShell.execute("rm one.txt two.txt three.txt four.txt")
          ),
        ],
        { concurrency: "unbounded" }
      );

      for (const error of [creationError, deletionError]) {
        expect(error).toMatchObject({
          _tag: "ShellLimitExceededError",
          limit: "overlay-entries",
        });
      }
    })
  );

  it.effect(
    "keeps standard shell globs without scanning the full served tree",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all([
            writeFile(join(servedRoot, "a.txt"), "a\n"),
            writeFile(join(servedRoot, "b.txt"), "b\n"),
            writeFile(join(servedRoot, "c.md"), "c\n"),
          ])
        );
        const shell = yield* makeShell();

        const [expanded, quoted] = yield* Effect.all(
          [shell.execute("ls *.txt | sort"), shell.execute("ls '*.txt'")],
          { concurrency: "unbounded" }
        );

        expect(expanded.exitCode).toBe(0);
        expect(expanded.stdout.trim().split("\n")).toEqual(["a.txt", "b.txt"]);
        expect(quoted.exitCode).not.toBe(0);
      })
  );

  it.effect("charges an existing host file when append materializes it", () =>
    Effect.gen(function* () {
      const path = join(servedRoot, "host.txt");
      yield* Effect.promise(() => writeFile(path, "12345678"));
      const shell = yield* makeShell({
        maxFileReadBytes: 16,
        maxOverlayBytes: 8,
      });

      const error = yield* Effect.flip(shell.execute("printf x >> host.txt"));

      expect(error).toMatchObject({
        _tag: "ShellLimitExceededError",
        limit: "overlay",
      });
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
        "12345678"
      );
    })
  );

  it.effect("charges host files materialized by chmod and touch", () =>
    Effect.gen(function* () {
      const path = join(servedRoot, "host.txt");
      yield* Effect.promise(() => writeFile(path, "12345678"));

      const errors = yield* Effect.all(
        ["chmod 600 host.txt", "touch host.txt"].map((script) =>
          makeShell({
            maxFileReadBytes: 16,
            maxOverlayBytes: 4,
          }).pipe(Effect.flatMap((shell) => Effect.flip(shell.execute(script))))
        ),
        { concurrency: "unbounded" }
      );

      for (const error of errors) {
        expect(error).toMatchObject({
          _tag: "ShellLimitExceededError",
          limit: "overlay",
        });
      }
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
        "12345678"
      );
    })
  );

  it.effect("charges host files materialized by copy and move", () =>
    Effect.gen(function* () {
      const path = join(servedRoot, "host.txt");
      yield* Effect.promise(() => writeFile(path, "12345678"));

      const errors = yield* Effect.all(
        ["cp host.txt copy.txt", "mv host.txt moved.txt"].map((script) =>
          makeShell({
            maxFileReadBytes: 16,
            maxOverlayBytes: 4,
          }).pipe(Effect.flatMap((shell) => Effect.flip(shell.execute(script))))
        ),
        { concurrency: "unbounded" }
      );

      for (const error of errors) {
        expect(error).toMatchObject({
          _tag: "ShellLimitExceededError",
          limit: "overlay",
        });
      }
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
        "12345678"
      );
    })
  );
});
