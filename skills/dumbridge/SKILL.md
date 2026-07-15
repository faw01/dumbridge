---
name: dumbridge
description: Find, inspect, and pull live files from a user's read-only dumbridge served root into a cloud agent workspace. Use when a task needs local-only or uncommitted context, skills, fixtures, images, datasets, or environment files exposed through a dumbridge bridge key.
---

# dumbridge

Treat the served root like a read-only external drive. Use the CLI directly; do not add an MCP server or another runner. `dumbridge skill` reprints this guide at any time.

## The bridge key

The bridge key is a bearer secret: anyone holding it while `serve` runs can read everything below the served root. Handle it like a password.

`run` and `pull` resolve the key in one fixed order:

1. `--key-file <path>` when given, reading the key from that file; `--key-file -` reads it from stdin.
2. The `DUMBRIDGE_KEY` environment variable otherwise.

Prefer a secret file or secret-injected environment variable over anything that records the value: if the harness mounts secrets as files, pass `--key-file /path/to/secret`; if it injects environment variables, rely on `DUMBRIDGE_KEY` already being set. Never run `export DUMBRIDGE_KEY=...` or paste the key into a command line, because shell history and command logs keep it. Stdin is read only when `--key-file -` asks for it, so piping other data into `run` stays safe.

## Workflow

1. Confirm a bridge key is available - a secret file for `--key-file` or an already-set `DUMBRIDGE_KEY` - without printing its value.
2. Discover candidates in place with `dumbridge run`.
3. Preview only the bounded text or metadata needed to select a candidate.
4. Pull the exact relative path into the current workspace.
5. Continue with ordinary local tools against the pulled copy.

```bash
dumbridge run 'find . -path "*/skills/*/SKILL.md" -print | sort'
dumbridge run 'sed -n "1,240p" .agents/skills/wayfinder/SKILL.md'
dumbridge pull .agents/skills/wayfinder .agents/skills/wayfinder
```

For ambiguously named binary files, inspect metadata before pulling:

```bash
dumbridge run 'find photos -iname "IMG*.jpg" -print | sort'
dumbridge run 'file photos/IMG2123.jpg; stat photos/IMG2123.jpg; sha256sum photos/IMG2123.jpg'
dumbridge pull photos/IMG2123.jpg assets/reference.jpg
```

## Boundaries

- Pass one quoted Bash-shaped script to `run`. Prefer `find`, `rg`, `grep`, `sed`, `file`, `stat`, and checksums.
- Use relative paths below the served root. `pull` does not expand globs.
- Do not print secret file contents merely to decide whether to pull them. Pull an exact `.env` path directly when the task requires it.
- Never print, log, or repeat the bridge key; it is a bearer secret. Never pass it as a command argument or export it in a shell command.
- Expect writes inside `run` to disappear. dumbridge cannot change the user's local files.
- Expect existing destinations and symlinks to be refused. Choose a new destination instead of deleting or overwriting one.
- If the key is absent, expired, or the bridge is offline, ask the user to run `dumbridge serve <root>` locally and place the new key in the cloud environment. Keys expire after a TTL the user chose at serve time.

## Recognizing failures

- The first `run` prints `dumbridge: serving '<name>' as /workspace (read-only)` naming the served root; paths in `run` and `pull` are relative to it.
- `is outside the served root`: the path left the one shared directory. Nothing above the served root exists here; go back to relative paths from `.`.
- `The bridge process is unreachable`: `dumbridge serve` stopped or the machine went offline. Ask the user to start it again and provide the new key.
- `The bridge rejected the bridge key` or `The bridge key is invalid`: the key is stale, expired, or mistyped. Ask the user for the key printed by the currently running `dumbridge serve`.
- `No bridge key is set`: neither `--key-file` nor `DUMBRIDGE_KEY` supplied one. Check the secret file path or the environment.
- Every dumbridge failure exits non-zero, so `&&` chains and scripts can rely on the exit code.
