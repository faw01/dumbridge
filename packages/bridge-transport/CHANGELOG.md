# @dumbridge/bridge-transport

## 0.2.1

### Patch Changes

- c1d6f0a: repin the iroh-ffi proxy patch to upstream 1.1.0 base

## 0.2.0

### Minor Changes

- ddc0c01: Trust extra CA roots for TLS-intercepting proxies end-to-end behind the bridge transport seam. When run or pull commits to an HTTP(S) proxy, the client resolves an extra CA certificate from `DUMBRIDGE_CA_FILE`, `CODEX_PROXY_CERT`, or `SSL_CERT_FILE` (in that precedence) and passes its PEM contents to a CA-trust-capable iroh binding; trust is additive only and the roots vouch for the relay TLS inside the proxy's CONNECT tunnel. A stock binding or an unreadable file degrades with one stderr notice and connects without the extra roots — never a pre-network dead-end — and `doctor` gains a `ca-trust` check mirroring exactly what run and pull do. This is the dumbridge half that Codex Cloud's Envoy MITM proxy needs; the binding half already ships in `dumbridge-iroh@1.0.0-proxy.0`.

### Patch Changes

- ddc0c01: Thread the proxy environment through the bridge transport seam as a required value instead of an ambient `process.env` default, so a dial always reads the same environment the proxy commitment was made with. The proxy environment variable list now lives in one shared predicate consumed by both the client's transport selection and the doctor diagnosis.
- 5e9978c: Ship 1.0.0 on the stable line by pointing the `@number0/iroh` alias at `dumbridge-iroh@1.0.0`, the patched iroh binding rebuilt for all eleven napi targets stock `@number0/iroh` ships. Every install now gets a binding that can route the relay WebSocket through an HTTP(S) proxy and trust extra CA roots for TLS-intercepting proxies, so proxy-jailed cloud agents (Claude Code on the web, Codex Cloud) work from the default install instead of a quarantined `proxy` dist-tag prerelease. The client keeps feature-detecting the builder methods rather than pinning to the fork, so the ADR 0006 exit — dropping the alias once upstream ships them — stays a dependency-line swap.

## 0.1.0

### Minor Changes

- ddd99ea: Split the connect-failure error by observed cause and log the dial sequence at debug level. A failed dial is classified at the transport seam: the bridge not answering while the relay is reachable (serve stopped or the machine is offline), the relay host unreachable or blocked (naming the exact host to allowlist), no viable network path for a direct-only key, and — after the unusable-proxy fallback — the proxy named as the likely cause once the connection actually fails. `--log-level debug` on run or pull logs the dial sequence (paths attempted, relay used, outcomes) on stderr without exposing the bridge key or proxy credentials.
- 0797ea6: Report the connection path selected at connect time as one stderr line on every run and pull, and add mutually exclusive `serve --direct-only` / `serve --relay-only` path-forcing flags. A direct-only key allows no relay fallback and fails fast with a branded error when holepunching fails; relay-only constrains the initial dial best effort only, and the session may still upgrade to a direct path.
- 39dc7c4: Add `dumbridge doctor`: a no-key, no-session environment diagnosis that prints one self-descriptive check per line — DNS resolution of the iroh relay hosts, UDP egress, relay reachability on port 443, and HTTP(S) proxy capability — and exits non-zero when any check fails. The transport seam gains an iroh-agnostic `diagnose` returning the check results, so proxy-only or UDP-blocked sandboxes can be told apart from a stopped bridge before minting a key.
- f05d372: Fall back to a direct-capable connection when a proxy environment variable is set but the installed iroh binding cannot route through it, instead of failing before any network attempt. The client prints one stderr warning (never the proxy URL), leaves the relay policy to the locator in the bridge key — a direct-only key stays a direct-only attempt — and a proxied environment with no working direct or relay route now fails as a genuine connection failure rather than the pre-network configuration dead-end.

### Patch Changes

- aa85aae: Strip narrating comments across the codebase while keeping the constraint-explaining notes (TOCTOU guards, expiry ordering, PID-reuse liveness, wire sanitization, and similar). No behavior changes.
- b14e59d: Strip narrating comments added by the reliability wave while keeping constraint-explaining notes (proxy fallback ordering, relay-link snapshot teardown, root-keyed detach records, probe assumptions, and similar). No behavior changes.
