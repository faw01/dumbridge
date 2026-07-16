---
"dumbridge": minor
"@dumbridge/bridge-transport": minor
---

Split the connect-failure error by observed cause and log the dial sequence at debug level. A failed dial is classified at the transport seam: the bridge not answering while the relay is reachable (serve stopped or the machine offline), the relay host unreachable or blocked (naming the exact host to allowlist), no viable network path for a direct-only key, and — after the unusable-proxy fallback — the proxy named as the likely cause once the connection actually fails. `--log-level debug` on run or pull logs the dial sequence (paths attempted, relay used, outcomes) on stderr without exposing the bridge key or proxy credentials.
