# dumbridge

Use Bun for package management and runtime commands. Run `bun run verify` before committing.

Keep the product surface to `serve`, `run`, `pull`, and the read-only informational `skill` verb. The local side is read-only: never execute the host shell or write below the served root. Effect v4 owns the CLI and lifecycle; iroh stays behind the `BridgeTransport` seam; Just Bash stays behind the `SafeShell` seam. Prefer a few deep modules, explicit Effect errors, and tests through public behavior. Comments explain constraints, not code narration.

Commits use one-line conventional commits with a required scope, for example `feat(bridge): stream pull responses`. Do not add commit bodies, footers, or co-authors.

CI gates pull requests with `fallow audit` over changed files; `.fallowrc.json` is the policy. Dead-code analysis stays in default mode because exports-for-tests is repo policy; production mode flags six test-consumed exports. Never run `fallow fix --production` — it would strip those exports and break the suite; preview any fix with `fallow fix --dry-run`. Semantic-mode duplication stays out of CI (noisy against Effect Schema boilerplate); run `fallow dupes --mode semantic` manually per release.

## Agent skills

### Issue tracker

Work is tracked in GitHub Issues. External PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-role label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read `CONTEXT.md` and relevant files in `docs/adr/` before changing behavior. See `docs/agents/domain.md`.
