# dumbridge

dumbridge gives a disposable cloud coding agent temporary, live, read-only access to one local directory.

## Quick start

dumbridge requires Bun 1.3.14 or newer on `PATH`; both `bunx` and `npx --yes` work.

On the computer that owns the files:

```bash
bunx dumbridge serve ~/Documents/GitHub
```

Keep that process open. Put the printed `DUMBRIDGE_KEY` value in the cloud agent's environment without logging or committing it. In the cloud agent:

```bash
npx --yes dumbridge skill
npx --yes dumbridge run 'find . -name SKILL.md -print | sort'
npx --yes dumbridge pull .agents/skills/wayfinder .agents/skills/wayfinder
```

`skill` prints the bundled agent usage guide. `run` uses a bounded Just Bash filesystem, not the host shell, and its writes disappear after the request. `pull` accepts one exact relative path, refuses symlinks and existing destinations, and verifies content before publishing it. `run` and `pull` also accept the key through `--key-file <path>` (`-` reads stdin) instead of the environment.

The bridge is one-way and the key is a bearer secret. Ctrl-C on `serve` revokes access. Every key expires on a deadline fixed at mint time (default 8 hours, `serve --ttl '90 minutes'`). `serve --detach <root>` runs the same server detached from the terminal, and `serve --stop` terminates it, which revokes the key.

## Prerelease limitation

Direct iroh connections and ordinary relay fallback work. Proxy-only cloud agents need a proxy-enabled native iroh binding that is not yet published with this package. Do not treat Codex or Cursor cloud connectivity as released until that native matrix has been built and tested.
