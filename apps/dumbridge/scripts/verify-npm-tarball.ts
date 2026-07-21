import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };

interface PackFile {
  readonly path: string;
}

interface PackManifest {
  readonly files: readonly PackFile[];
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const allowedPaths = ["LICENSE", "README.md", "dist/cli.js", "package.json"];
const allowedPathSet = new Set(allowedPaths);
const maxArchiveBytes = 2 * 1024 * 1024;
const maxDistBytes = 5 * 1024 * 1024;
const newlinePattern = /\r?\n/;
const packedFilePattern = /^packed\s+\S+\s+(.+)$/;

const assertWithinLimit = (label: string, bytes: number, limit: number) => {
  if (bytes > limit) {
    throw new Error(`${label} is ${bytes} bytes; limit is ${limit} bytes`);
  }
};

const spawnChecked = (
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

  for (const allowedPath of allowedPaths) {
    if (!paths.includes(allowedPath)) {
      problems.push(`missing expected file: ${allowedPath}`);
    }
  }

  for (const path of paths) {
    if (!allowedPathSet.has(path)) {
      problems.push(`unexpected package entry: ${path}`);
    }
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

    spawnChecked(
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
    const archive = await stat(archivePath);
    assertWithinLimit("package archive", archive.size, maxArchiveBytes);
    const packageManagerEnv = {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: cacheDirectory,
      TEMP: tempDirectory,
      TMP: tempDirectory,
      TMPDIR: tempDirectory,
    };
    spawnChecked(
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

    const help = spawnChecked(
      ["bunx", "--no-install", "dumbridge", "--help"],
      consumerDirectory,
      packageManagerEnv
    );
    const version = spawnChecked(
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

    const installedManifestPath = join(
      consumerDirectory,
      "node_modules",
      "dumbridge",
      "package.json"
    );
    const reVersioned = "0.0.0-verify-tarball";
    const manifest = JSON.parse(await installedManifest.text()) as {
      version: string;
    };
    await writeFile(
      installedManifestPath,
      `${JSON.stringify({ ...manifest, version: reVersioned }, null, 2)}\n`
    );
    const reVersionedOutput = spawnChecked(
      ["bunx", "--no-install", "dumbridge", "--version"],
      consumerDirectory,
      packageManagerEnv
    );
    if (reVersionedOutput.trim() !== `dumbridge v${reVersioned}`) {
      throw new Error(
        `packed executable reports the build-time version, not the installed manifest version: got '${reVersionedOutput.trim()}'`
      );
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

const verifyPack = async () => {
  const executable = await stat(join(packageRoot, "dist", "cli.js"));
  assertWithinLimit("dist/cli.js", executable.size, maxDistBytes);

  const output = spawnChecked(
    ["bun", "pm", "pack", "--dry-run", "--ignore-scripts"],
    packageRoot
  );

  const paths = output.split(newlinePattern).flatMap((line) => {
    const match = packedFilePattern.exec(line);
    return match?.[1] ? [match[1]] : [];
  });
  const manifest: PackManifest = {
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
