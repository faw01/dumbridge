# dumbridge

dumbridge gives a disposable cloud coding agent temporary, live, read-only access to one local directory.

It is published on npm as [`dumbridge`](https://www.npmjs.com/package/dumbridge); the 0.1.0 `serve` / `run` / `pull` flow has been proven end to end from a real Cursor Cloud agent with `npx --yes dumbridge@0.1.0`. Bun 1.3.14 or newer must be on `PATH`; both `bunx` and `npx` work.

## Quick start

On the computer that owns the files:

```bash
bunx dumbridge serve ~/Documents/GitHub
```

Keep that process in the foreground; Ctrl-C revokes access. Put the printed `DUMBRIDGE_KEY` value in the cloud agent's environment without logging or committing it.

In the cloud agent:

```bash
npx --yes dumbridge skill
npx --yes dumbridge run 'find . -path "*/skills/*/SKILL.md" -print | sort'
npx --yes dumbridge pull .agents/skills/wayfinder .agents/skills/wayfinder
```

## Commands

- `dumbridge serve <root>` shares one directory read-only until Ctrl-C and prints the `DUMBRIDGE_KEY` bearer secret, valid for a configurable TTL (default 8 hours, `--ttl '90 minutes'`). `serve --detach <root>` starts the same server detached from the terminal, and `serve --stop` terminates it, which revokes the key.
- `dumbridge run '<script>'` evaluates one Bash-shaped script against the live served root in a bounded Just Bash sandbox, never the host shell. Its writes are discarded.
- `dumbridge pull <remote-path> [destination]` copies one exact file or directory, verifies content, refuses symlinks, and never overwrites an existing destination.
- `dumbridge skill` prints the bundled agent usage guide without contacting a bridge.

The bridge key is a bearer secret: anyone holding it while `serve` is running can read below the served root.

Every key carries an expiry deadline fixed when `serve` mints it, enforced by the serve process itself: after the deadline, sessions are rejected even if the process keeps running. Stopping the bridge process still revokes access immediately. The deadline matters most for a detached bridge (`serve --detach`, tracked in [#22](https://github.com/faw01/dumbridge/issues/22)), where a long-lived server would otherwise mint a never-expiring credential; once the key expires, the detached process keeps running but grants nothing, and rerunning `serve` mints a fresh key.

## Status

The complete flow works over direct iroh connections and ordinary relay fallback. Proxy-only cloud agents still require the included iroh binding patch to be built and published for each native platform; stock `@number0/iroh` does not expose that proxy configuration yet. See [the proxy patch](docs/patches/iroh-ffi-proxy.md) and [the release gates](docs/design/v1.md#release-gates).

CI runs on GitHub-hosted macOS, Linux, and Windows runners. Exact CPU and libc support remains a native release gate.

## Development

```bash
bun install --frozen-lockfile
bun run verify
```

This is a Bun workspace orchestrated by Turborepo. The publishable CLI is in `apps/dumbridge`; the internal seams (`bridge-key`, `bridge-transport`, `wire`, `served-root`, `safe-shell`, `pull-transfer`) are private packages under `packages/*` that get bundled into the published `dist/cli.js`. The optional agent instructions are in `skills/dumbridge`.

See [the v1 design](docs/design/v1.md) for the product and security contract and [CONTEXT.md](CONTEXT.md) for its domain language.
