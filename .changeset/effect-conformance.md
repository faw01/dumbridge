---
"dumbridge": patch
---

Sharpen error fidelity across the bridge: deterministic connect failures (invalid locator, proxy configuration) are no longer retried, remapped client errors keep their underlying cause, swallowed serve-loop session failures are logged as redacted warnings, and the bridge key is read as a redacted config value.
