# dumbridge

## 0.3.0

### Minor Changes

- ddd99ea: Split the connect-failure error by observed cause and log the dial sequence at debug level. A failed dial is classified at the transport seam: the bridge not answering while the relay is reachable (serve stopped or the machine is offline), the relay host unreachable or blocked (naming the exact host to allowlist), no viable network path for a direct-only key, and — after the unusable-proxy fallback — the proxy named as the likely cause once the connection actually fails. `--log-level debug` on run or pull logs the dial sequence (paths attempted, relay used, outcomes) on stderr without exposing the bridge key or proxy credentials.
- 0797ea6: Report the connection path selected at connect time as one stderr line on every run and pull, and add mutually exclusive `serve --direct-only` / `serve --relay-only` path-forcing flags. A direct-only key allows no relay fallback and fails fast with a branded error when holepunching fails; relay-only constrains the initial dial best effort only, and the session may still upgrade to a direct path.
- 39dc7c4: Add `dumbridge doctor`: a no-key, no-session environment diagnosis that prints one self-descriptive check per line — DNS resolution of the iroh relay hosts, UDP egress, relay reachability on port 443, and HTTP(S) proxy capability — and exits non-zero when any check fails. The transport seam gains an iroh-agnostic `diagnose` returning the check results, so proxy-only or UDP-blocked sandboxes can be told apart from a stopped bridge before minting a key.
- 142babb: Allow multiple detached serves to run at once, at most one per served root: records are keyed by the resolved root, a second `serve --detach` on an already-served root is rejected naming that root, and `serve --stop` accepts a root to pick which serve to stop (a bare stop still works when exactly one is running and lists the served roots when several are). The record now also persists the key's expiry deadline; the key itself is still never written to any file.
- f05d372: Fall back to a direct-capable connection when a proxy environment variable is set but the installed iroh binding cannot route through it, instead of failing before any network attempt. The client prints one stderr warning (never the proxy URL), leaves the relay policy to the locator in the bridge key — a direct-only key stays a direct-only attempt — and a proxied environment with no working direct or relay route now fails as a genuine connection failure rather than the pre-network configuration dead-end.
- 56b59f5: Add `serve --status`: it lists each active detached serve with its served root, pid, start time, and key expiry, one per line, and prints `No detached serves are running.` (exit 0) when none are. Stale records — a dead pid or a record from a prior boot — are pruned as they are listed. Only the key's expiry deadline is shown; the key itself is never written or printed.

### Patch Changes

- 38b9cf9: Brand the remote read shell limit and traversal-budget failures: every limit message now states the configured ceiling, whether it is per-file or cumulative, and a recovery; a run exceeding the bridge's time budget is answered with a branded time-budget failure instead of a torn-down session; and a response the bridge ends early is reported as the bridge closing early rather than "The bridge returned an invalid response."
- 18660cd: Brand the pull-side failures: a pull response the bridge ends early and a lost connection are reported as such with causes attached instead of "The pull could not be completed.", and the pull limit messages state their ceilings and a recovery instead of a bare "exceeded a safety limit".
- aa85aae: Strip narrating comments across the codebase while keeping the constraint-explaining notes (TOCTOU guards, expiry ordering, PID-reuse liveness, wire sanitization, and similar). No behavior changes.
- b14e59d: Strip narrating comments added by the reliability wave while keeping constraint-explaining notes (proxy fallback ordering, relay-link snapshot teardown, root-keyed detach records, probe assumptions, and similar). No behavior changes.

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
