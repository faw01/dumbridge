---
name: dumbridge
description: Find, inspect, and pull live files from a user's read-only dumbridge served root into a cloud agent workspace. Use when a task needs local-only or uncommitted context, skills, fixtures, images, datasets, or environment files exposed through DUMBRIDGE_KEY.
---

# dumbridge

Treat the served root like a read-only external drive. Use the CLI directly; do not add an MCP server or another runner. `dumbridge skill` reprints this guide at any time.

## Workflow

1. Confirm `DUMBRIDGE_KEY` is available without printing its value.
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
- Never print, log, or repeat `DUMBRIDGE_KEY`; it is a bearer secret.
- Expect writes inside `run` to disappear. dumbridge cannot change the user's local files.
- Expect existing destinations and symlinks to be refused. Choose a new destination instead of deleting or overwriting one.
- If the key is absent, expired, or the bridge is offline, ask the user to run `dumbridge serve <root>` locally and place the new key in the cloud environment. Keys expire after a TTL the user chose at serve time.

## Recognizing failures

- The first `run` prints `dumbridge: serving '<name>' as /workspace (read-only)` naming the served root; paths in `run` and `pull` are relative to it.
- `is outside the served root`: the path left the one shared directory. Nothing above the served root exists here; go back to relative paths from `.`.
- `The bridge process is unreachable`: `dumbridge serve` stopped or the machine went offline. Ask the user to start it again and provide the new key.
- `The bridge rejected DUMBRIDGE_KEY` or `DUMBRIDGE_KEY is invalid`: the key is stale, expired, or mistyped. Ask the user for the key printed by the currently running `dumbridge serve`.
- Every dumbridge failure exits non-zero, so `&&` chains and scripts can rely on the exit code.
