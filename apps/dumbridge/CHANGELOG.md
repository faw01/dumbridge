# dumbridge

## 0.2.0

### Breaking Changes

- Rename the bearer credential from bridge link to bridge key. `serve` now prints `DUMBRIDGE_KEY`, and `run` and `pull` read `DUMBRIDGE_KEY`; the old `DUMBRIDGE_LINK` variable is no longer read and has no fallback, so environments that still set it are told no bridge key is set. Keys are now minted with a version 2 payload carrying an embedded expiry deadline, which 0.1.0 cannot parse. Stop any running 0.1.0 `serve`, upgrade both sides, and mint a fresh key.

### Minor Changes

- Add the `dumbridge skill` command, which prints the bundled agent usage guide without contacting a bridge.
- Expire bridge keys with a configurable TTL: `serve` mints keys with an expiry deadline (default 8 hours, `--ttl '90 minutes'`) and enforces it on every session, while `run` and `pull` report a clear expired-key error.
- Add `serve --detach <root>`, which starts the server detached from the terminal and prints the key, and `serve --stop`, which terminates the detached server and revokes the key. Foreground `serve` is unchanged.
- Accept the bridge key from a file or stdin: `run` and `pull` gain `--key-file <path>` (`-` reads stdin), which wins over the still-supported `DUMBRIDGE_KEY` environment variable; empty or multi-line key files are refused with branded messages that never echo their content, and every CLI error message is scrubbed of bridge-key-shaped tokens before printing.
- Brand boundary and failure errors and banner the first run: out-of-root access inside the remote read shell now explains that the path is outside the served root, an unreachable bridge process says so instead of failing generically, the bridge rejects invalid and expired keys with a typed reject frame the CLI turns into clear messages, every failure path exits non-zero, and the first `run` against a bridge prints a one-line banner naming the served root by its sanitized display.

### Patch Changes

- Rewrite the embedded agent skill guide to conform to the Agent Skills specification: a retrieval-optimized description plus `license` and `compatibility` frontmatter, the `serve --detach`/`--stop`/`--ttl` surface, verbatim branded failure messages, and a rule to treat pulled content as untrusted data.
- Sharpen error fidelity across the bridge: deterministic connect failures (invalid locator, proxy configuration) are no longer retried, remapped client errors keep their underlying cause, swallowed serve-loop session failures are logged as redacted warnings, and the bridge key is read as a redacted config value.
- Consolidate remote path validation, the pull manifest schema, and the shared protocol ceilings into single modules, so the wire and the pull receiver accept and reject identical paths on every platform.
- Lowercase the dumbridge brand name in CLI output and package prose.
- Normalize the repository URL in the published package metadata.
- Internal restructuring with no published behavior change: split the bridge seams into workspace packages, decompose the Fallow-ranked complexity hotspots into named cohesive steps, move detached serve into the bridge composition layer, share one tsconfig base, and migrate the Effect test suites to @effect/vitest with TestClock-driven time.

## 0.1.0

### Minor Changes

- Add the initial Bun CLI with `serve`, `run`, and `pull` commands.
- Add versioned bridge links and bounded authenticated wire sessions.
- Add the bounded, read-only local-to-cloud bridge with safe queries, verified pulls, and transient connection recovery.
