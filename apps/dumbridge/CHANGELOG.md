# dumbridge

## 0.2.0

### Minor Changes

- 71eec9e: Brand boundary and failure errors and banner the first run: out-of-root access inside the remote read shell now explains that the path is outside the served root, an unreachable bridge process says so instead of failing generically, the bridge rejects invalid and expired keys with a typed reject frame the CLI turns into clear messages, every failure path exits non-zero, and the first `run` against a bridge prints a one-line banner naming the served root by its sanitized display.
- 24b1830: Rename the bearer credential from bridge link to bridge key: `serve` now prints `DUMBRIDGE_KEY`, and `run` and `pull` read `DUMBRIDGE_KEY` instead of `DUMBRIDGE_LINK`. There is no fallback for the old variable name.
- 3a53c4b: Accept the bridge key from a file or stdin: `run` and `pull` gain `--key-file <path>` (`-` reads stdin), which wins over the still-supported `DUMBRIDGE_KEY` environment variable; empty or multi-line key files are refused with branded messages that never echo their content, and every CLI error message is scrubbed of bridge-key-shaped tokens before printing.
- ffaff69: Expire bridge keys with a configurable TTL: `serve` mints keys with an expiry deadline (default 8 hours, `--ttl '90 minutes'`) and enforces it on every session, while `run` and `pull` report a clear expired-key error.
- a37b474: Add `serve --detach <root>`, which starts the server detached from the terminal and prints the key, and `serve --stop`, which terminates the detached server and revokes the key. Foreground `serve` is unchanged.
- 555b546: Add the `dumbridge skill` command, which prints the bundled agent usage guide.

### Patch Changes

- 2f9f472: Rewrite the embedded agent skill guide to conform to the Agent Skills specification: a retrieval-optimized description plus `license` and `compatibility` frontmatter, the `serve --detach`/`--stop`/`--ttl` surface, verbatim branded failure messages, and a rule to treat pulled content as untrusted data. `dumbridge skill` prints the updated guide.
- fe51d50: Sharpen error fidelity across the bridge: deterministic connect failures (invalid locator, proxy configuration) are no longer retried, remapped client errors keep their underlying cause, swallowed serve-loop session failures are logged as redacted warnings, and the bridge key is read as a redacted config value.
- 2d02a45: Migrate the Effect test suites to @effect/vitest it.effect with TestClock-driven time, keep the Bun-runtime suites on bun test, and adopt the @effect/language-service tsconfig plugin; no published behavior change.
- 1850bc6: Decompose the Fallow-ranked complexity hotspots (served-root host file reads, wire frame encoding, manifest entry validation, the incremental frame reader) into named cohesive steps with behavior unchanged.
- cff7121: Lowercase the dumbridge brand name in CLI output and package prose.
- 34133bf: Consolidate remote path validation, the pull manifest schema, and the shared protocol ceilings into single modules, so the wire and the pull receiver accept and reject identical paths on every platform.
- 13f58c7: Move detached serve into the bridge composition layer and extend every tsconfig from a shared typescript-config package; no published behavior change.
- 317ce56: Normalize the repository URL in the published package metadata.

## 0.1.0

### Minor Changes

- Add the initial Bun CLI with `serve`, `run`, and `pull` commands.
- Add versioned bridge links and bounded authenticated wire sessions.
- Add the bounded, read-only local-to-cloud bridge with safe queries, verified pulls, and transient connection recovery.
