# dumbridge

Use Bun for package management and runtime commands. Run `bun run verify` before committing.

Keep the product surface to `serve`, `run`, `pull`, the no-key `doctor` diagnosis, and the read-only informational `skill` verb. The local side is read-only: never execute the host shell or write below the served root. Effect v4 owns the CLI and lifecycle; iroh stays behind the `BridgeTransport` seam; Just Bash stays behind the `SafeShell` seam. Prefer a few deep modules, explicit Effect errors, and tests through public behavior. Comments explain constraints, not code narration.

Tests use `@effect/vitest` `it.effect`; time-dependent tests use `TestClock`, not real-time polling. Effect suites run through vitest under the Bun runtime (`bun --bun vitest run`); suites requiring Bun APIs (`bun:ffi` in atomic-publish, real CLI process spawns, the tarball check) stay on `bun test`, and each package's `test` script runs every runner it needs. Read config through `Config`; use `Config.redacted` for secret-bearing values; `process.env` may only appear in `cli.ts` and test files.

Commits use one-line conventional commits with a required scope, for example `feat(bridge): stream pull responses`. Do not add commit bodies, footers, or co-authors.

Releases are automated. `dumbridge` in `apps/dumbridge` is the only published package; everything under `packages/*` is private and stays private. On every push to `main`, `.github/workflows/release.yml` runs verify and then changesets/action: queued changesets open or update a `chore(release): version packages` PR, and merging it publishes to npm through trusted publishing (GitHub OIDC, no `NPM_TOKEN`, provenance attached). The workflow filename is pinned in the npm-side trusted-publisher config, so renaming `release.yml` requires updating npmjs.com. The changeset-status gate skips the generated `changeset-release/main` branch, which consumes changesets by design; an empty changeset must never sit on `main` because it stalls the publish path. Owner-authenticated `npm publish` from `apps/dumbridge` remains the manual fallback.

CI gates pull requests with `fallow audit` over changed files; `.fallowrc.json` is the policy. Dead-code analysis stays in default mode because exports-for-tests is repo policy; production mode flags six test-consumed exports. Never run `fallow fix --production` — it would strip those exports and break the suite; preview any fix with `fallow fix --dry-run`. Semantic-mode duplication stays out of CI (noisy against Effect Schema boilerplate); run `fallow dupes --mode semantic` manually per release.

## Agent skills

### Issue tracker

Work is tracked in GitHub Issues. External PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-role label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read `CONTEXT.md` and relevant files in `docs/adr/` before changing behavior. See `docs/agents/domain.md`.
