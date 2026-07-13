# Dumbridge

Dumbridge gives a disposable cloud coding agent temporary, live, read-only access to one local directory.

The repository is a Bun workspace orchestrated by Turborepo. The publishable CLI lives in `apps/dumbridge` and uses Effect v4's unstable CLI with the Bun platform runtime.

## Development

```bash
bun install --frozen-lockfile
bun run verify
```

See [the v1 design](docs/design/v1.md) for the product and security contract.
