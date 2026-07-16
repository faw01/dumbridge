---
"dumbridge": minor
---

Allow multiple detached serves to run at once, at most one per served root: records are keyed by the resolved root, a second `serve --detach` on an already-served root is rejected naming that root, and `serve --stop` accepts a root to pick which serve to stop (a bare stop still works when exactly one is running and lists the served roots when several are). The record now also persists the key's expiry deadline; the key itself is still never written to any file.
