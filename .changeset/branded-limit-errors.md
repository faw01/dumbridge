---
"dumbridge": patch
---

Brand the remote read shell limit and traversal-budget failures: every limit message now states the configured ceiling, whether it is per-file or cumulative, and a recovery; a run exceeding the bridge's time budget is answered with a branded time-budget failure instead of a torn-down session; and a response the bridge ends early is reported as the bridge closing early rather than "The bridge returned an invalid response."
