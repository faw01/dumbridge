---
"dumbridge": minor
---

Add `serve --status`: it lists each active detached serve with its served root, pid, start time, and key expiry, one per line, and prints `No detached serves are running.` (exit 0) when none are. Stale records — a dead pid or a record from a prior boot — are pruned as they are listed. Only the key's expiry deadline is shown; the key itself is never written or printed.
