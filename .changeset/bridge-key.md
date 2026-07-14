---
"dumbridge": minor
---

Rename the bearer credential from bridge link to bridge key: `serve` now prints `DUMBRIDGE_KEY`, and `run` and `pull` read `DUMBRIDGE_KEY` instead of `DUMBRIDGE_LINK`. There is no fallback for the old variable name.
