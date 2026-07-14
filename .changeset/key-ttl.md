---
"dumbridge": minor
---

Expire bridge keys with a configurable TTL: `serve` mints keys with an expiry deadline (default 8 hours, `--ttl '90 minutes'`) and enforces it on every session, while `run` and `pull` report a clear expired-key error.
