---
"dumbridge": minor
"@dumbridge/bridge-transport": minor
---

Add `dumbridge doctor`: a no-key, no-session environment diagnosis that prints one self-descriptive check per line — DNS resolution of the iroh relay hosts, UDP egress, relay reachability on port 443, and HTTP(S) proxy capability — and exits non-zero when any check fails. The transport seam gains an iroh-agnostic `diagnose` returning the check results, so proxy-only or UDP-blocked sandboxes can be told apart from a stopped bridge before minting a key.
