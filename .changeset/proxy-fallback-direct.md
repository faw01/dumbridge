---
"dumbridge": minor
"@dumbridge/bridge-transport": minor
---

Fall back to a direct-capable connection when a proxy environment variable is set but the installed iroh binding cannot route through it, instead of failing before any network attempt. The client prints one stderr warning (never the proxy URL), leaves the relay policy to the locator in the bridge key — a direct-only key stays a direct-only attempt — and a proxied environment with no working direct or relay route now fails as a genuine connection failure rather than the pre-network configuration dead-end.
