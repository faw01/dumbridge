import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };

interface PackFile {
  readonly path: string;
}

interface PackManifest {
  readonly entryCount: number;
  readonly files: readonly PackFile[];
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const requiredPaths = ["LICENSE", "README.md", "dist/cli.js", "package.json"];
const forbiddenSegments = new Set([
  ".env",
  ".git",
  ".repos",
  "node_modules",
  "scripts",
  "src",
  "test",
]);
const maxEntryCount = 20;
const newlinePattern = /\r?\n/;
const packedFilePattern = /^packed\s+\S+\s+(.+)$/;

const run = (
  command: string[],
  cwd: string,
  env?: Record<string, string | undefined>
) => {
  const result = Bun.spawnSync(command, {
    ...(env ? { env } : {}),
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed: ${result.stderr.toString().trim()}`
    );
  }

  return result.stdout.toString();
};

export const assessPackManifest = (manifest: PackManifest) => {
  const paths = manifest.files.map((file) => file.path);
  const problems: string[] = [];

  for (const requiredPath of requiredPaths) {
    if (!paths.includes(requiredPath)) {
      problems.push(`missing expected file: ${requiredPath}`);
    }
  }

  for (const path of paths) {
    const segments = path.split("/");
    if (
      segments.some((segment) => forbiddenSegments.has(segment)) ||
      segments.some((segment) => segment.startsWith(".env"))
    ) {
      problems.push(`forbidden package entry: ${path}`);
    }
  }

  if (manifest.entryCount > maxEntryCount) {
    problems.push(
      `entry count ${manifest.entryCount} exceeds ${maxEntryCount}`
    );
  }

  return problems;
};

const verifyInstalledArchive = async () => {
  const temporaryParent = join(packageRoot, "node_modules", ".cache");
  await mkdir(temporaryParent, { recursive: true });
  const temporaryRoot = await mkdtemp(join(temporaryParent, "dumbridge-pack-"));

  try {
    const archiveDirectory = join(temporaryRoot, "archive");
    const cacheDirectory = join(temporaryParent, "bun-install");
    const consumerDirectory = join(temporaryRoot, "consumer");
    const tempDirectory = join(temporaryRoot, "tmp");
    await Promise.all([
      mkdir(archiveDirectory, { recursive: true }),
      mkdir(cacheDirectory, { recursive: true }),
      mkdir(consumerDirectory, { recursive: true }),
      mkdir(tempDirectory, { recursive: true }),
    ]);
    await writeFile(
      join(consumerDirectory, "package.json"),
      `${JSON.stringify({ name: "pack-consumer", private: true })}\n`
    );

    run(
      [
        "bun",
        "pm",
        "pack",
        "--destination",
        archiveDirectory,
        "--ignore-scripts",
        "--quiet",
      ],
      packageRoot
    );
    const archives = (await readdir(archiveDirectory)).filter((name) =>
      name.endsWith(".tgz")
    );
    if (archives.length !== 1 || !archives[0]) {
      throw new Error("package build did not create exactly one tarball");
    }
    const archivePath = join(archiveDirectory, archives[0]);
    const packageManagerEnv = {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: cacheDirectory,
      TEMP: tempDirectory,
      TMP: tempDirectory,
      TMPDIR: tempDirectory,
    };
    run(
      ["bun", "add", archivePath, "--ignore-scripts"],
      consumerDirectory,
      packageManagerEnv
    );

    const installedManifest = Bun.file(
      join(consumerDirectory, "node_modules", "dumbridge", "package.json")
    );
    if (!(await installedManifest.exists())) {
      throw new Error(
        "clean install did not contain the packed dumbridge package"
      );
    }

    const help = run(
      ["bunx", "--no-install", "dumbridge", "--help"],
      consumerDirectory,
      packageManagerEnv
    );
    const version = run(
      ["bunx", "--no-install", "dumbridge", "--version"],
      consumerDirectory,
      packageManagerEnv
    );
    if (
      !help.includes("dumbridge") ||
      version.trim() !== `dumbridge v${packageJson.version}`
    ) {
      throw new Error(
        "packed executable returned unexpected help or version output"
      );
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

const verifyPack = async () => {
  const output = run(
    ["bun", "pm", "pack", "--dry-run", "--ignore-scripts"],
    packageRoot
  );

  const paths = output.split(newlinePattern).flatMap((line) => {
    const match = packedFilePattern.exec(line);
    return match?.[1] ? [match[1]] : [];
  });
  const manifest: PackManifest = {
    entryCount: paths.length,
    files: paths.map((path) => ({ path })),
  };

  const problems = assessPackManifest(manifest);
  if (problems.length > 0) {
    throw new Error(`package verification failed:\n- ${problems.join("\n- ")}`);
  }

  await verifyInstalledArchive();
};

if (import.meta.main) {
  await verifyPack();
}
