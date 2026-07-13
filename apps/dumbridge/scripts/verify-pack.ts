import { fileURLToPath } from "node:url";

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

const verifyPack = () => {
  const result = Bun.spawnSync(
    ["bun", "pm", "pack", "--dry-run", "--ignore-scripts"],
    {
      cwd: packageRoot,
      stderr: "pipe",
      stdout: "pipe",
    }
  );

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    throw new Error(`bun pm pack --dry-run failed: ${stderr}`);
  }

  const paths = result.stdout
    .toString()
    .split(newlinePattern)
    .flatMap((line) => {
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
};

if (import.meta.main) {
  verifyPack();
}
