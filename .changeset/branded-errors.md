---
"dumbridge": minor
---

Brand boundary and failure errors and banner the first run: out-of-root access inside the remote read shell now explains that the path is outside the served root, an unreachable bridge process says so instead of failing generically, the bridge rejects invalid and expired keys with a typed reject frame the CLI turns into clear messages, every failure path exits non-zero, and the first `run` against a bridge prints a one-line banner naming the served root by its sanitized display.
