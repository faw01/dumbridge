---
"dumbridge": major
"@dumbridge/bridge-transport": patch
---

Ship 1.0.0 on the stable line by pointing the `@number0/iroh` alias at `dumbridge-iroh@1.0.0`, the patched iroh binding rebuilt for all eleven napi targets stock `@number0/iroh` ships. Every install now gets a binding that can route the relay WebSocket through an HTTP(S) proxy and trust extra CA roots for TLS-intercepting proxies, so proxy-jailed cloud agents (Claude Code on the web, Codex Cloud) work from the default install instead of a quarantined `proxy` dist-tag prerelease. The client keeps feature-detecting the builder methods rather than pinning to the fork, so the ADR 0006 exit — dropping the alias once upstream ships them — stays a dependency-line swap.
