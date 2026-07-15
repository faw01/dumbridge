// The generated version PR (changeset-release/main) consumes every queued
// changeset by design, so the coverage gate would always fail there.
const generatedVersionBranch = "changeset-release/main";

if (process.env.GITHUB_HEAD_REF === generatedVersionBranch) {
  process.stdout.write(
    `changeset status skipped: ${generatedVersionBranch} consumes changesets by design\n`
  );
  process.exit(0);
}

const result = Bun.spawnSync(
  ["bunx", "changeset", "status", "--since=origin/main"],
  { stderr: "inherit", stdout: "inherit" }
);
process.exit(result.exitCode);
