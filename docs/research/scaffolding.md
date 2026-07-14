# Dumbridge scaffolding research

Research date: 2026-07-14

> Decision note: this records the initial research recommendation. The owner subsequently chose a Bun-only runtime, a Turborepo workspace, and no release workflow or OIDC publishing. The implemented decision in `docs/design/v1.md` is authoritative.

## Recommendation

Dumbridge should begin as **one publishable TypeScript CLI package**, not a monorepo. Use Bun as the repository package manager and local task runner, but keep that choice separate from the runtime contract of the published CLI. If `npx dumbridge` must work on a clean cloud agent that has Node but not Bun, the shipped executable must retain a Node shebang and run on Node; using `bun install`, `bun test`, or `bun run` during development does not require shipping a Bun-only executable.

Adopt the production hygiene from create-mf2-app selectively:

- Ultracite with only its Biome `core` preset.
- A separate TypeScript typecheck.
- Changesets for release notes, version PRs, and npm publication.
- A package-content verification script built around `npm pack --dry-run`.
- Cross-platform CI on Linux, macOS, and Windows because the Iroh dependency is native.
- CONTRIBUTING, SECURITY, issue/PR templates, Dependabot, an MIT license, and concise agent instructions.
- npm trusted publishing through OIDC rather than a long-lived npm write token.

Do **not** add Turborepo, workspaces, Husky, lint-staged, a documentation app, or the large mf2 skill/template tree yet. They do not deepen the interface of a single CLI and would make every contributor learn more configuration than Dumbridge currently needs.

## Reference repositories

### Clone into `.repos`

| Destination | Repository | Why it earns a local clone |
| --- | --- | --- |
| `.repos/create-mf2-app` | [`faw01/create-mf2-app`](https://github.com/faw01/create-mf2-app) | The actual generator source contains the CLI package, package verification, Changesets, CI, release automation, contribution files, and generated template. This is the useful scaffold reference. |
| `.repos/effect-solutions` | [`kitlangton/effect-solutions`](https://github.com/kitlangton/effect-solutions) | A current, runnable Effect 4 beta CLI using `effect/unstable/cli`, Effect services, Bun, tests, Changesets, and compiled binaries. Treat it as an implementation example, not as a stable contract. |
| `.repos/effect-skills` | [`betalyra/effect-skills`](https://github.com/betalyra/effect-skills) | Agent-oriented Effect patterns for services, errors, layers, schemas, observability, and testing. It is supplemental guidance and should be pinned to a commit when consulted because its opinions can lag Effect beta releases. |

`.repos/just-bash` is already present, so it does not need cloning again.

### Do not clone by default

| Repository | Decision |
| --- | --- |
| [`faw01/mf2`](https://github.com/faw01/mf2) | Optional. It is the generated SaaS template output. Clone it only to compare what create-mf2-app emits; it does not add useful CLI/release machinery beyond the generator source. |
| [`haydenbleasel/ultracite`](https://github.com/haydenbleasel/ultracite) | Use the released package and official setup docs. Its large source monorepo is not needed to configure one preset. |
| [`vercel/turborepo`](https://github.com/vercel/turborepo) | Do not clone or install while Dumbridge is one package. |
| [`changesets/changesets`](https://github.com/changesets/changesets) and [`changesets/action`](https://github.com/changesets/action) | Use the published CLI/action and official documentation; their implementation source is not needed locally. |

The existing networking reference set remains appropriate: `iroh`, `iroh-ffi`, `sendme`, and `dumbpipe` explain the transport and transfer layers, while these new references explain repository and CLI discipline.

## What to learn from create-mf2-app

The source repo is a large Bun/Turborepo workspace, but its individual CLI package is a conventional npm executable: it declares `bin`, restricts published `files`, sets a Node engine, enables public-package provenance metadata, bundles to ESM with a Node shebang, and verifies the tarball before packing. See its [CLI package manifest](https://github.com/faw01/create-mf2-app/blob/main/apps/cli/package.json), [tsup configuration](https://github.com/faw01/create-mf2-app/blob/main/apps/cli/tsup.config.ts), and [`verify-pack.js`](https://github.com/faw01/create-mf2-app/blob/main/apps/cli/scripts/verify-pack.js).

Copy the ideas, not the application-specific implementation:

- Keep a restrictive `files` allowlist in `package.json`.
- Make `prepack` build and inspect the exact npm tarball.
- Fail if required entries are absent, secrets or `.env*` files are present, or the package becomes anomalously large.
- Publish only `dist`, `README.md`, `LICENSE`, and any deliberately shipped agent skill. Never publish `.repos`, tests, local configuration, or research notes.

Its [Changesets config](https://github.com/faw01/create-mf2-app/blob/main/.changeset/config.json), [CI workflow](https://github.com/faw01/create-mf2-app/blob/main/.github/workflows/ci.yml), [release workflow](https://github.com/faw01/create-mf2-app/blob/main/.github/workflows/release.yml), and [Dependabot configuration](https://github.com/faw01/create-mf2-app/blob/main/.github/dependabot.yml) are useful starting points, but should be rewritten for a single CLI.

Three parts should **not** be copied verbatim:

1. The root `apps/*` / `packages/*` workspace and `turbo.json` solve a many-app SaaS generator, not Dumbridge.
2. Its CI currently uses `bun install` without a frozen-lockfile check. Dumbridge CI should use `bun install --frozen-lockfile`.
3. Its `SECURITY.md` tells reporters to open an issue. Dumbridge handles local filesystem access and remote capabilities, so vulnerability details must be reported privately, never through a public issue. GitHub supports structured [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

## Proposed repository shape

```text
dumbridge/
├── .changeset/
│   ├── README.md
│   └── config.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug.yml
│   │   └── feature.yml
│   ├── workflows/
│   │   ├── ci.yml
│   │   └── release.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── SECURITY.md
│   ├── dependabot.yml
│   └── pull_request_template.md
├── .repos/                     # ignored research dependencies
├── docs/
│   ├── design/
│   └── research/
├── src/
├── test/
├── AGENTS.md
├── CHANGELOG.md
├── LICENSE
├── README.md
├── biome.jsonc
├── bun.lock
├── package.json
└── tsconfig.json
```

There should be no `apps/`, `packages/`, workspace declaration, or `turbo.json` until a second independently buildable package actually exists.

## Tooling decisions

### Bun: yes for repository development, runtime decision remains explicit

Bun officially supplies package installation, scripts, testing, bundling, npm publishing, and standalone compilation; it can also select platform-specific dependencies with `--cpu` and `--os`. Those capabilities make it a good package manager and development tool. Its [official repository](https://github.com/oven-sh/bun) and [standalone executable documentation](https://bun.sh/docs/bundler/executables) describe these roles.

However, a Bun-only package with `#!/usr/bin/env bun` requires Bun to exist on the target machine. The current [effect-solutions package](https://github.com/kitlangton/effect-solutions/blob/main/packages/cli/package.json) deliberately makes that choice and additionally builds platform-specific executables. Dumbridge's stated installation path includes `npx`, so the safe default is:

- `packageManager: "bun@<pinned-version>"` and a committed `bun.lock`.
- Bun for installation and developer scripts.
- Node-compatible published JavaScript with `#!/usr/bin/env node` unless the project explicitly switches to a matrix of standalone binaries.
- CI smoke tests under the same runtime users receive. A Bun test pass alone is not proof that the Node-distributed CLI works.

### Effect CLI: compatible, but its beta status must be visible

Effect CLI does not conflict with Iroh or Just Bash. They live at different seams:

- Effect CLI parses Dumbridge's own commands and provides help/errors.
- Effect manages lifecycle, cancellation, typed failures, configuration, and dependency layers.
- Iroh carries network streams.
- Just Bash evaluates the restricted remote command.

The current effect.solutions guide installs `effect@beta` plus either `@effect/platform-bun@beta` or `@effect/platform-node@beta`, and imports the CLI from `effect/unstable/cli`; it also documents that flags precede positional arguments. See the first-party [Effect CLI guide](https://github.com/kitlangton/effect-solutions/blob/main/packages/website/docs/13-cli.md). That means Dumbridge should pin exact beta versions and test passthrough cases such as `dumbridge run -- rg -n foo .` before committing to the parser. This is a product-interface risk, not an incompatibility with Iroh or Just Bash.

The [`betalyra/effect-skills`](https://github.com/betalyra/effect-skills/blob/main/effect-best-practices/SKILL.md) material should inform implementation style, but it is intentionally opinionated and is not a substitute for version-matched official Effect documentation.

### Ultracite: yes, core preset only

Ultracite is a preset over existing linters/formatters, and currently supports Biome, ESLint/Prettier, and Oxlint/Oxfmt. Its official initializer supports Bun and a Biome selection; its documented commands are `ultracite check`, `ultracite fix`, and `ultracite doctor`. See [Ultracite setup](https://github.com/haydenbleasel/ultracite/blob/main/apps/docs/setup.mdx).

For Dumbridge:

```jsonc
{
  "extends": ["ultracite/biome/core"]
}
```

Do not copy create-mf2-app's React or Next presets. Add scripts equivalent to:

```json
{
  "check": "ultracite check",
  "fix": "ultracite fix",
  "typecheck": "tsc --noEmit"
}
```

Linting and formatting do not replace compiler typechecking. Install the tools as pinned development dependencies rather than relying on whatever version `bunx` happens to resolve in CI.

### Turborepo: omit

Turborepo officially supports [single-package workspaces](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/guides/single-package-workspaces.mdx), where it can cache and orchestrate tasks. Support does not make it useful here. Dumbridge currently has one dependency graph node and short `check`, `typecheck`, `test`, and `build` commands. Turbo would add its own configuration, cache semantics, and debugging surface without removing real complexity.

Reconsider Turbo only when at least one of these becomes true:

- Dumbridge owns two or more independently buildable/publishable packages.
- Native bindings are built as platform packages with a real dependency graph.
- CI timings show repeated expensive tasks for which cache hits materially help.

Until then, plain `package.json` scripts are the deeper interface.

### Changesets: adopt even for one package

Changesets explicitly supports a standalone project: `changeset init` creates `.changeset/config.json`, and `changeset version` consumes authored change files to update the package version and changelog. Single-package tags use `v<version>`. See the official [CLI README](https://github.com/changesets/changesets/blob/main/packages/cli/README.md), [configuration reference](https://github.com/changesets/changesets/blob/main/docs/config-file-options.md), and [command reference](https://github.com/changesets/changesets/blob/main/docs/command-line-options.md).

Use:

- `access: "public"` if Dumbridge will be public on npm.
- `baseBranch: "main"`.
- A required changeset for user-visible changes, with a documented escape hatch for docs/tests/internal chores.
- `changesets/action@v2` to maintain the version PR and publish after it merges. The current action supports OIDC trusted publishing; see its [official configuration](https://github.com/changesets/action/blob/main/_autodocs/configuration.md).

## CI and release design

### Pull-request CI

Use minimal workflow permissions (`contents: read`) and a matrix that includes:

```text
ubuntu-latest
macos-latest
windows-latest
```

GitHub provides all three hosted runner families, and its workflow matrix supports selecting the runner from `matrix.os`; see the [GitHub Actions documentation](https://docs.github.com/en/actions/learn-github-actions/understanding-github-actions).

Every platform should:

1. Install the pinned Bun version.
2. Run `bun install --frozen-lockfile`.
3. Run the typecheck and tests.
4. Build the CLI.
5. Run a packaged-CLI smoke test (`--help`, `--version`, and a local no-network command).
6. Exercise loading the shipped Iroh Node-API dependency on that OS and architecture.

An Ubuntu-only quality job can additionally run Ultracite and package-manifest verification. The verifier should execute `npm pack --dry-run --json --ignore-scripts` and assert the tarball allowlist, as create-mf2-app already demonstrates.

Add Dependabot entries for `npm` and `github-actions` at `/`, weekly, with a small pull-request limit. GitHub's [Dependabot documentation](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configuring-dependabot-version-updates) confirms both ecosystems can be maintained from `.github/dependabot.yml`.

### Release

Prefer npm trusted publishing through GitHub OIDC:

- Release workflow permissions: `contents: write`, `pull-requests: write`, and `id-token: write` only.
- Configure the exact repository/workflow as the npm trusted publisher.
- Use Node 22.14+ and npm 11.5.1+ in the publish job.
- Do not store an `NPM_TOKEN` after trusted publishing is working.
- Disable package-manager caches in the release job and build from the lockfile.

npm documents that trusted publishing removes long-lived write tokens and automatically produces provenance for qualifying public packages built from public repositories. Private source repositories can use trusted publishing, but npm does not generate public provenance for them. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

The release workflow must rebuild, test, verify the tarball, and publish the artifact produced in that same job. It should not trust an unverified local `dist/` committed by a contributor.

## Repository hygiene

### `SECURITY.md`

Write this specifically for Dumbridge rather than copying a generic template. It should state:

- Supported versions.
- That vulnerabilities must use GitHub's private **Report a vulnerability** flow.
- A fallback private contact if that feature is unavailable.
- Expected acknowledgement and status-update windows.
- That capability leakage, path escape, symlink escape, unauthorized reads, command-sandbox escape, and secret exposure are in scope.
- That reporters must not include exploit details in public issues.

Also enable private vulnerability reporting in repository settings. GitHub explains that this gives reporters a private, structured advisory channel independent of `SECURITY.md`. See [configuring private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

### `CONTRIBUTING.md`

Include facts contributors actually need:

- Supported Bun and Node versions.
- Exact install, check, typecheck, test, build, and smoke-test commands.
- The three-platform support promise.
- How to add a Changeset.
- Where the protocol/design documents live.
- The rule that security reports do not belong in issues.
- How `.repos` is used and why it is never committed or published.

### Issue and PR templates

Rewrite create-mf2-app's generic templates around a CLI. A bug report should require:

- `dumbridge --version`.
- Installation route (`npx`, npm global, Bun, Homebrew, standalone binary).
- OS, version, CPU architecture, Node/Bun version.
- Which side failed (Mac/server or cloud/client).
- Sanitized command, exit code, stdout/stderr, and whether direct or relay connectivity was used.
- An explicit warning not to paste Dumbridge links, capabilities, `.env` contents, or private paths.

The PR checklist should require tests, a Changeset when user-visible, documentation for interface changes, three-platform consideration, and confirmation that no capability or fixture secret entered logs. Remove web-specific screenshot boilerplate.

### Additional small files

- MIT `LICENSE`, with the correct Dumbridge copyright holder.
- `README.md` with installation, the three-command happy path, security model, supported platforms, and current limitations.
- `CHANGELOG.md`, managed by Changesets.
- Root `AGENTS.md` containing only the real commands, architectural seams, testing expectations, and pointers into `docs/`; avoid vendoring a large general-purpose skill library.
- `.gitignore` covering `.repos`, `node_modules`, `dist`, coverage, local environment files, logs, and platform/editor noise.

Do not add Husky or lint-staged initially. Fast explicit scripts plus required CI provide one source of truth and avoid hooks behaving differently across Windows, cloud agents, and local clones.

## Scaffold acceptance criteria

The scaffold is done when all of these are true:

1. A fresh checkout installs reproducibly from the committed lockfile.
2. `check`, `fix`, `typecheck`, `test`, `build`, and `pack:check` are documented and run independently without Turbo.
3. The built package exposes `dumbridge`, has the intended runtime shebang, and contains only the allowlisted files.
4. `--help` and `--version` work from the packed tarball on Linux, macOS, and Windows.
5. CI loads the real Iroh native dependency on all supported platforms.
6. Changesets can create a version PR and the release job can publish through OIDC.
7. Private vulnerability reporting is enabled and `SECURITY.md` never directs exploit details to a public issue.
8. `.repos` and all local research material are absent from `npm pack` output.

## Bottom line

Use create-mf2-app as a **hygiene donor**, effect-solutions as an **Effect CLI specimen**, and effect-skills as **agent guidance**. Keep Dumbridge itself boring: one package, plain scripts, reproducible Bun installs, a Node-compatible npm executable unless the distribution decision explicitly changes, Ultracite core, Changesets, and a real three-OS test matrix. Turborepo becomes justified only after the repository genuinely becomes a graph.
