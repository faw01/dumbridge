# dumbridge

dumbridge gives a cloud coding agent temporary, live, read-only access to one local directory.

## Install

No install step is needed. Run it with `bunx dumbridge` or `npx --yes dumbridge`. Bun 1.3.14 or newer must be on `PATH`.

## Quickstart

On the computer that owns the files:

1. Start the bridge:

```bash
bunx dumbridge serve ~/projects/my-app
```

2. Copy the printed `DUMBRIDGE_KEY` value.
3. Put it in the cloud agent's environment as a secret. Do not log it or commit it.
4. Keep the serve process running. Ctrl-C stops it and revokes access.

In the cloud agent:

```bash
npx --yes dumbridge run 'ls -la'
npx --yes dumbridge pull src/config.json
```

`run` evaluates one script against the served root and prints its output. `pull` copies one file or directory from the served root into the current directory.

## Commands

- `dumbridge serve <root>` serves one directory read-only and prints the bridge key. The key expires after 8 hours by default; set a different lifetime with `--ttl '90 minutes'`. `--detach` starts the server without a terminal, `--stop` ends a detached serve, and `--status` lists the active ones. `--direct-only` and `--relay-only` force the connection path.
- `dumbridge run '<script>'` evaluates one Bash-shaped script against the served root in a bounded sandbox. Writes are discarded. It never runs the host shell.
- `dumbridge pull <remote-path> [destination]` copies one file or directory from the served root. It verifies content, refuses symlinks, and never overwrites an existing destination.
- `dumbridge doctor` diagnoses the network environment without a key and exits non-zero when a check fails.
- `dumbridge skill` prints the bundled agent usage guide without contacting a bridge.

`run` and `pull` read the bridge key from `DUMBRIDGE_KEY`, or from `--key-file <path>` (`-` reads stdin). The key is never accepted as a command argument. Failures exit non-zero with a plain message that names the cause; `--log-level debug` on `run` or `pull` logs the dial sequence on stderr without exposing the key.

## What it can and cannot do

- Read-only. The agent can read files below the served root. It cannot write to your machine.
- One directory. Only the directory you pass to `serve` is visible. Reads outside it are refused.
- No host shell. `run` uses a sandboxed interpreter, and its writes are discarded.
- Short-lived key. The bridge key is a bearer secret: anyone holding it can read the served root while `serve` runs. It expires on a deadline fixed when `serve` mints it, and stopping `serve` revokes it immediately.

## Using it from a cloud agent

Put the `DUMBRIDGE_KEY` value in the agent's environment, then use `run` and `pull` as shown above. Proxy-jailed sandboxes work: the bundled iroh binding routes the relay connection through the environment's HTTP(S) proxy and can trust an extra CA certificate for TLS-intercepting proxies (`DUMBRIDGE_CA_FILE`, `CODEX_PROXY_CERT`, or `SSL_CERT_FILE`).

- Claude Code on the web: set Network access to Full.
- Codex Cloud: set the Domain allowlist to All (unrestricted).
- Cursor: works with no extra setup.

If a connection fails, run `npx --yes dumbridge doctor` in the agent to diagnose the environment.

## License

MIT
