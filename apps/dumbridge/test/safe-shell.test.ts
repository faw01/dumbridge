import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SafeShell, type SafeShellLimits } from "../src/shell/safe-shell";

let fixtureRoot = "";
let servedRoot = "";
let outsideRoot = "";

const makeShell = (limits?: Partial<SafeShellLimits>) =>
  Effect.runPromise(SafeShell.make(servedRoot, limits));

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

    const [traversal, absolute, linked] = await Promise.all([
      Effect.runPromise(shell.execute("cat ../outside/secret.txt")),
      Effect.runPromise(shell.execute(`cat '${absolutePath}'`)),
      Effect.runPromise(shell.execute("cat escape/secret.txt")),
    ]);

    for (const result of [traversal, absolute, linked]) {
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("outside secret");
    }
  });

  test("does not expose host, network, Python, or JavaScript commands", async () => {
    const shell = await makeShell();

    const result = await Effect.runPromise(
      shell.execute("git; curl; python3; node; js-exec")
    );

    expect(result.exitCode).toBe(127);
    for (const command of ["git", "curl", "node", "js-exec"]) {
      expect(result.stderr).toContain(`${command}: command not found`);
    }
    expect(result.stderr).toContain("python3: command not available");
  });

  test("fails closed when script, command, loop, output, or file limits are exceeded", async () => {
    await writeFile(join(servedRoot, "large.txt"), "0123456789");

    const cases = [
      {
        effect: (await makeShell({ maxScriptBytes: 8 })).execute(
          "echo too long"
        ),
        limit: "script",
      },
      {
        effect: (await makeShell({ maxCommandCount: 3 })).execute(
          "true; true; true; true"
        ),
        limit: "commands",
      },
      {
        effect: (await makeShell({ maxLoopIterations: 5 })).execute(
          "while true; do true; done"
        ),
        limit: "loops",
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

    const failures = await Promise.all(
      cases.map(async (item) => ({
        error: await Effect.runPromise(Effect.flip(item.effect)),
        limit: item.limit,
      }))
    );

    for (const failure of failures) {
      const { error, limit } = failure;
      expect(error).toMatchObject({
        _tag: "ShellLimitExceededError",
        limit,
      });
    }
  });
});
