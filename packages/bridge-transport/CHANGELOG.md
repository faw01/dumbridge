# @dumbridge/bridge-transport

## 0.1.0

### Minor Changes

- ddd99ea: Split the connect-failure error by observed cause and log the dial sequence at debug level. A failed dial is classified at the transport seam: the bridge not answering while the relay is reachable (serve stopped or the machine is offline), the relay host unreachable or blocked (naming the exact host to allowlist), no viable network path for a direct-only key, and — after the unusable-proxy fallback — the proxy named as the likely cause once the connection actually fails. `--log-level debug` on run or pull logs the dial sequence (paths attempted, relay used, outcomes) on stderr without exposing the bridge key or proxy credentials.
- 0797ea6: Report the connection path selected at connect time as one stderr line on every run and pull, and add mutually exclusive `serve --direct-only` / `serve --relay-only` path-forcing flags. A direct-only key allows no relay fallback and fails fast with a branded error when holepunching fails; relay-only constrains the initial dial best effort only, and the session may still upgrade to a direct path.
- 39dc7c4: Add `dumbridge doctor`: a no-key, no-session environment diagnosis that prints one self-descriptive check per line — DNS resolution of the iroh relay hosts, UDP egress, relay reachability on port 443, and HTTP(S) proxy capability — and exits non-zero when any check fails. The transport seam gains an iroh-agnostic `diagnose` returning the check results, so proxy-only or UDP-blocked sandboxes can be told apart from a stopped bridge before minting a key.
- f05d372: Fall back to a direct-capable connection when a proxy environment variable is set but the installed iroh binding cannot route through it, instead of failing before any network attempt. The client prints one stderr warning (never the proxy URL), leaves the relay policy to the locator in the bridge key — a direct-only key stays a direct-only attempt — and a proxied environment with no working direct or relay route now fails as a genuine connection failure rather than the pre-network configuration dead-end.

### Patch Changes

- aa85aae: Strip narrating comments across the codebase while keeping the constraint-explaining notes (TOCTOU guards, expiry ordering, PID-reuse liveness, wire sanitization, and similar). No behavior changes.
- b14e59d: Strip narrating comments added by the reliability wave while keeping constraint-explaining notes (proxy fallback ordering, relay-link snapshot teardown, root-keyed detach records, probe assumptions, and similar). No behavior changes.
