# dumbridge

dumbridge gives a disposable cloud coding agent temporary, live, read-only access to one local directory.

dumbridge currently requires Bun 1.3.14 or newer. Install Bun once, then run the package directly from npm.

```bash
# On the computer that owns the files
bunx dumbridge serve ~/Documents/GitHub

# In the cloud agent, with DUMBRIDGE_LINK set
bunx dumbridge run 'find . -path "*/skills/*/SKILL.md" -print | sort'
bunx dumbridge pull .agents/skills/wayfinder .agents/skills/wayfinder
```

npm's package runner works too when Bun is on `PATH`:

```bash
npx --yes dumbridge --help
```

`serve` stays in the foreground and Ctrl-C revokes the link. `run` evaluates a bounded Bash-shaped query in Just Bash, never the host shell. Its writes are discarded. `pull` stages and verifies one exact file or directory, refuses symlinks, and never overwrites an existing destination.

The bridge link is a bearer secret. Anyone holding it while `serve` is running can read below the served root.

## Status

dumbridge is an early prerelease. The complete `serve` / `run` / `pull` flow works over direct Iroh connections and ordinary relay fallback. Proxy-only cloud agents still require the included Iroh binding patch to be built and published for each native platform; stock `@number0/iroh` does not expose that proxy configuration yet. See [the proxy patch](docs/patches/iroh-ffi-proxy.md) and [the release gates](docs/design/v1.md#release-gates).

CI runs on GitHub-hosted macOS, Linux, and Windows runners. Exact CPU and libc support remains a native release gate.

## Development

```bash
bun install --frozen-lockfile
bun run verify
```

This is a Bun workspace orchestrated by Turborepo. The publishable CLI is in `apps/dumbridge`; the optional agent instructions are in `skills/dumbridge`.

See [the v1 design](docs/design/v1.md) for the product and security contract and [CONTEXT.md](CONTEXT.md) for its domain language.
