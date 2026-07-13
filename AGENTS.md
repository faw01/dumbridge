# Dumbridge

Use Bun for package management and runtime commands. Run `bun run check`, `bun run typecheck`, and `bun run test` before committing.

Keep the product surface to `serve`, `run`, and `pull`. The local side is read-only: never execute the host shell or write below the served root. Prefer a few deep modules, explicit Effect errors, and tests through public behavior. Comments explain constraints, not code narration.

Commits use one-line conventional commits with a required scope, for example `feat(bridge): stream pull responses`. Do not add commit bodies, footers, or co-authors.

## Agent skills

### Issue tracker

Work is tracked in GitHub Issues. External PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-role label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read `CONTEXT.md` and relevant files in `docs/adr/` before changing behavior. See `docs/agents/domain.md`.
