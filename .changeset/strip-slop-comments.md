---
"dumbridge": patch
"@dumbridge/bridge-key": patch
"@dumbridge/bridge-transport": patch
"@dumbridge/pull-transfer": patch
"@dumbridge/remote-path": patch
"@dumbridge/safe-shell": patch
"@dumbridge/served-root": patch
"@dumbridge/wire": patch
---

Strip narrating comments across the codebase while keeping the constraint-explaining notes (TOCTOU guards, expiry ordering, PID-reuse liveness, wire sanitization, and similar). No behavior changes.
