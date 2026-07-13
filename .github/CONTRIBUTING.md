# Contributing

Use Bun 1.3.14 or newer. Install with `bun install --frozen-lockfile`, then run `bun run verify`.

Keep changes focused on the read-only `serve`, `run`, and `pull` product contract in `docs/design/v1.md`. Add a Changeset with `bunx changeset` for user-visible package changes. Consider Linux, macOS, and Windows behavior, especially paths and subprocess-free shell execution.

Local reference repositories belong in `.repos`; they are never committed or published. Report security issues privately according to `SECURITY.md`, never in a public issue.
