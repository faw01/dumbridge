# Iroh FFI proxy patch

This patch exists because proxy-only cloud agents (the Codex cloud release
gate, issue #9) can only reach an iroh relay by tunneling WSS through the
environment's HTTP(S) proxy, and the published `@number0/iroh` binding does not
expose iroh's existing `proxy_url` / `proxy_from_env` builder methods. Until an
upstream release exposes them, this source patch is the only path to that
configuration.

## Status

[`patches/iroh-ffi-proxy.patch`](../../patches/iroh-ffi-proxy.patch) is a
source-only patch against `n0-computer/iroh-ffi` commit
`66e628e0fd2b7d526d01b81269041c97fc97f7a5` (`@number0/iroh@1.0.0`). This
repository does not build or publish an Iroh fork.

The patch exposes two capabilities that already exist on Iroh's Rust endpoint
builder:

- `EndpointBuilder.proxyFromEnv()` delegates to Rust's `proxy_from_env()`.
- `EndpointBuilder.proxyUrl(url)` parses the URL in Rust, then delegates to
  `proxy_url(url)`.

No proxy is implemented in dumbridge, and the patch does not add a network
service. It only makes Iroh's existing HTTP(S)-proxy configuration reachable
from the Node-API binding.

## Review and apply

From a clean checkout at the pinned commit:

```sh
git apply --check /path/to/dumbridge/patches/iroh-ffi-proxy.patch
git apply /path/to/dumbridge/patches/iroh-ffi-proxy.patch
```

`iroh-js/index.d.ts` is generated output in the upstream project. It is present
in the patch so the JavaScript contract can be reviewed without building the
native addon; the release build must regenerate it and produce the same two
method names.

dumbridge feature-detects `proxyUrl`. For `FromEnvironment`, it follows Iroh's
documented `HTTP_PROXY`, `http_proxy`, `HTTPS_PROXY`, `https_proxy` precedence,
then accepts `ALL_PROXY` or `all_proxy` as a generic fallback. It ignores
uppercase `HTTP_PROXY` in CGI contexts, requires an HTTP(S) URL, and passes that
exact choice to `proxyUrl`; SOCKS and malformed values fail closed. It does not trust the void
`proxyFromEnv` call as proof that a proxy was selected. Stock
`@number0/iroh@1.0.0` continues to fail with `BridgeProxyUnsupportedError`,
before binding a socket. Proxy URLs and native error strings are not included
in public typed errors.

## External release gate

Proxy support is not shippable merely because this source patch applies. The
remaining external gate is to build, test, and publish patched native packages
for every supported Iroh Node target, point dumbridge at that release, and then
prove a relay connection from each supported hosted-agent network through its
real HTTP/HTTPS proxy. That proof must include any required `iroh.link` relay
allowlist. Until both the native package matrix and hosted-network proof exist,
stock installs honestly report proxy configuration as unsupported.
