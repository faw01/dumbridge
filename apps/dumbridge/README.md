# dumbridge

dumbridge gives a disposable cloud coding agent temporary, live, read-only access to one local directory.

## Quick start

dumbridge currently requires Bun 1.3.14 or newer.

On the computer that owns the files:

```bash
bunx dumbridge serve ~/Documents/GitHub
```

Keep that process open. Put the printed `DUMBRIDGE_LINK` value in the cloud agent's environment without logging or committing it. In the cloud agent:

```bash
bunx dumbridge run 'find . -name SKILL.md -print | sort'
bunx dumbridge run 'sed -n "1,200p" .agents/skills/wayfinder/SKILL.md'
bunx dumbridge pull .agents/skills/wayfinder .agents/skills/wayfinder
```

npm's package runner can launch the same binary when Bun is already on `PATH`:

```bash
npx --yes dumbridge --help
```

`run` uses a bounded Just Bash filesystem, not the host shell. Writes disappear after the request. `pull` accepts one exact relative path, refuses symlinks and existing destinations, and verifies content before publishing it.

The bridge is one-way and the link is a bearer secret. Ctrl-C on `serve` revokes access.

## Prerelease limitation

Direct Iroh connections and ordinary relay fallback work. Proxy-only cloud agents need a proxy-enabled native Iroh binding that is not yet published with this package. Do not treat Codex or Cursor cloud connectivity as released until that native matrix has been built and tested.
