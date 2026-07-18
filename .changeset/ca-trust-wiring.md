---
"dumbridge": minor
"@dumbridge/bridge-transport": minor
---

Trust extra CA roots for TLS-intercepting proxies end-to-end behind the bridge transport seam. When run or pull commits to an HTTP(S) proxy, the client resolves an extra CA certificate from `DUMBRIDGE_CA_FILE`, `CODEX_PROXY_CERT`, or `SSL_CERT_FILE` (in that precedence) and passes its PEM contents to a CA-trust-capable iroh binding; trust is additive only and the roots vouch for the relay TLS inside the proxy's CONNECT tunnel. A stock binding or an unreadable file degrades with one stderr notice and connects without the extra roots — never a pre-network dead-end — and `doctor` gains a `ca-trust` check mirroring exactly what run and pull do. This is the dumbridge half that Codex Cloud's Envoy MITM proxy needs; the binding half already ships in `dumbridge-iroh@1.0.0-proxy.0`.
