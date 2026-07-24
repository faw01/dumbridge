# Iroh FFI proxy and CA trust patch

This patch exists because proxy-jailed cloud agents (Claude Code web, Codex
Cloud — the Codex cloud release gate, issue #9) can only reach an iroh relay by
tunneling WSS through the environment's HTTP(S) proxy, and Codex additionally
TLS-intercepts that tunnel with a private CA. iroh's Rust core has supported
both knobs for some time — `proxy_url` / `proxy_from_env` since PR
n0-computer/iroh#2298 (relay WebSocket coverage in #3217) and extra CA roots
via `CaTlsConfig::with_extra_roots` since #3973 / #4300 — but the published
`@number0/iroh` Node-API binding exposes neither, up to and including 1.1.0.
This source patch surfaces that existing configuration; it adds no networking
logic of its own.

## Status

[`patches/iroh-ffi-proxy.patch`](../../patches/iroh-ffi-proxy.patch) is a
source patch against `n0-computer/iroh-ffi` commit
`bc7eb0d28a5389323abdf9a878c8f3b45bdcb499` (`@number0/iroh@1.1.0`).

A build of this patch is published as **`dumbridge-iroh@1.1.0`** on npm
(matching the patched upstream version) across all eleven napi targets stock
`@number0/iroh` ships (each native binary rides its own
`dumbridge-iroh-<triple>` optional dependency), and `dumbridge` consumes it
through the alias `"@number0/iroh": "npm:dumbridge-iroh@1.1.0"`.
[`patches/dumbridge-iroh.package.json`](../../patches/dumbridge-iroh.package.json)
pins the published fork manifest. ADR 0006 records why the fork exists, its
guardrails, and its exit condition. To reproduce the published binding: check
out the pinned commit, apply the patch, and run the fork's
`dumbridge_release.yml` workflow, which builds `iroh-js` with napi-rs for all
eleven targets, probes the artifacts on real hardware for four architectures,
and refuses to publish unless every artifact is staged; the published manifest
must match the pinned one.

The patch exposes three capabilities that already exist on Iroh's Rust
endpoint builder:

- `EndpointBuilder.proxyFromEnv()` delegates to Rust's `proxy_from_env()`.
- `EndpointBuilder.proxyUrl(url)` parses the URL in Rust, then delegates to
  `proxy_url(url)`.
- `EndpointBuilder.caExtraRootsPem(pem)` parses the PEM in Rust, then delegates
  to `ca_tls_config(CaTlsConfig::default().with_extra_roots(...))`. Trust is
  additive only: the embedded WebPKI roots stay trusted and the given
  certificates are layered on top; there is no replace-roots or verify-off
  form. PEM contents (not a file path) cross the binding so all file I/O stays
  at dumbridge's edge. Known limitation of the published build: the method
  rejects malformed PEM framing and empty input, but a certificate with valid
  PEM framing and malformed DER inside is silently ignored by rustls's
  best-effort root loading (`add_parsable_certificates`), so such input can
  succeed while adding no trust anchor. A stricter per-certificate validation
  belongs in a future binding build and the upstream iroh-ffi PR;
  `dumbridge-iroh@1.1.0` repackages the same patched source for all targets
  without changing it, so the limitation carries over unchanged.

No proxy is implemented in dumbridge, and the patch does not add a network
service. It only makes Iroh's existing HTTP(S)-proxy and CA-trust
configuration reachable from the Node-API binding.

## Review and apply

From a clean checkout at the pinned commit:

```sh
git apply --check /path/to/dumbridge/patches/iroh-ffi-proxy.patch
git apply /path/to/dumbridge/patches/iroh-ffi-proxy.patch
```

`iroh-js/index.d.ts` is generated output in the upstream project. It is present
in the patch so the JavaScript contract can be reviewed without building the
native addon; the release build must regenerate it and produce the same three
method names.

dumbridge feature-detects `proxyUrl` and `caExtraRootsPem`. For
`FromEnvironment`, it follows Iroh's documented `HTTP_PROXY`, `http_proxy`,
`HTTPS_PROXY`, `https_proxy` precedence, then accepts `ALL_PROXY` or
`all_proxy` as a generic fallback. It ignores uppercase `HTTP_PROXY` in CGI
contexts, requires an HTTP(S) URL, and passes that exact choice to `proxyUrl`;
SOCKS and malformed values fail closed. It does not trust the void
`proxyFromEnv` call as proof that a proxy was selected. Stock
`@number0/iroh@1.0.0` continues to fail with `BridgeProxyUnsupportedError`,
before binding a socket. Proxy URLs and native error strings are not included
in public typed errors.

## External release gate

The native package matrix that kept the fork off `latest` is satisfied:
`dumbridge-iroh@1.0.0` ships all eleven napi targets stock `@number0/iroh`
ships, four of them probed on real hardware of the target architecture, so
the alias no longer regresses Windows, musl, or arm installs.
With that leg closed, dumbridge's stable line consumes the fork.

The remaining external gate is the ADR 0006 exit: a PR to `n0-computer/iroh-ffi`
adding the same passthrough builder methods, so a stock `@number0/iroh`
release surfaces them and dumbridge drops the alias. Until then every upstream
binding release costs a manual rebase, rebuild, and republish of the fork, and
each newly supported hosted-agent network still needs its relay connection
proven through that network's real HTTP/HTTPS proxy, including any required
`iroh.link` relay allowlist.
