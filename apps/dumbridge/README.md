# Dumbridge

Dumbridge gives a disposable cloud coding agent temporary, live, read-only access to one local directory.

## Quick start from source

Keep a repository checkout on each computer. On the computer that owns the files, run this from the repository root:

```bash
bun install --frozen-lockfile
bun apps/dumbridge/src/cli.ts serve ~/Documents/GitHub
```

Keep that process open. Put the printed `DUMBRIDGE_LINK` value in the cloud agent's environment without logging or committing it. From the cloud agent's checkout:

```bash
bun install --frozen-lockfile
bun apps/dumbridge/src/cli.ts run 'find . -name SKILL.md -print | sort'
bun apps/dumbridge/src/cli.ts run 'sed -n "1,200p" .agents/skills/wayfinder/SKILL.md'
bun apps/dumbridge/src/cli.ts pull .agents/skills/wayfinder .agents/skills/wayfinder
```

After the first package release, replace `bun apps/dumbridge/src/cli.ts` with `bunx dumbridge`.

`run` uses a bounded Just Bash filesystem, not the host shell. Writes disappear after the request. `pull` accepts one exact relative path, refuses symlinks and existing destinations, and verifies content before publishing it.

The bridge is one-way and the link is a bearer secret. Ctrl-C on `serve` revokes access.

## Prerelease limitation

Direct Iroh connections and ordinary relay fallback work. Proxy-only cloud agents need a proxy-enabled native Iroh binding that is not yet published with this package. Do not treat Codex or Cursor cloud connectivity as released until that native matrix has been built and tested.

Requires Bun 1.3.14 or newer.
