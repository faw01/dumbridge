# Dumbridge

Dumbridge gives a disposable cloud coding agent temporary, live, read-only access to one local directory.

For the source-only prerelease, keep a checkout on each computer and install its dependencies once.

```bash
# On the computer that owns the files, from the Dumbridge checkout
bun install --frozen-lockfile
bun apps/dumbridge/src/cli.ts serve ~/Documents/GitHub

# In the cloud agent, from its Dumbridge checkout, with DUMBRIDGE_LINK set
bun install --frozen-lockfile
bun apps/dumbridge/src/cli.ts run 'find . -path "*/skills/*/SKILL.md" -print | sort'
bun apps/dumbridge/src/cli.ts pull .agents/skills/wayfinder .agents/skills/wayfinder
```

After Dumbridge is published, the shorter package commands will be:

```bash
bunx dumbridge serve ~/Documents/GitHub
bunx dumbridge run 'find . -path "*/skills/*/SKILL.md" -print | sort'
bunx dumbridge pull .agents/skills/wayfinder .agents/skills/wayfinder
```

`serve` stays in the foreground and Ctrl-C revokes the link. `run` evaluates a bounded Bash-shaped query in Just Bash, never the host shell. Its writes are discarded. `pull` stages and verifies one exact file or directory, refuses symlinks, and never overwrites an existing destination.

The bridge link is a bearer secret. Anyone holding it while `serve` is running can read below the served root.

## Status

Dumbridge is a source-only prerelease. The complete `serve` / `run` / `pull` flow works over direct Iroh connections and ordinary relay fallback. Proxy-only cloud agents still require the included Iroh binding patch to be built and published for each native platform; stock `@number0/iroh` does not expose that proxy configuration yet. See [the proxy patch](docs/patches/iroh-ffi-proxy.md) and [the release gates](docs/design/v1.md#release-gates).

CI runs on GitHub-hosted macOS, Linux, and Windows runners. Exact CPU and libc support remains a native release gate.

## Development

```bash
bun install --frozen-lockfile
bun run verify
```

This is a Bun workspace orchestrated by Turborepo. The publishable CLI is in `apps/dumbridge`; the optional agent instructions are in `skills/dumbridge`.

See [the v1 design](docs/design/v1.md) for the product and security contract and [CONTEXT.md](CONTEXT.md) for its domain language.
