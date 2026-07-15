---
"dumbridge": minor
"@dumbridge/bridge-transport": minor
---

Report the connection path selected at connect time as one stderr line on every run and pull, and add mutually exclusive `serve --direct-only` / `serve --relay-only` path-forcing flags. A direct-only key allows no relay fallback and fails fast with a branded error when holepunching fails; relay-only constrains the initial dial best effort only, and the session may still upgrade to a direct path.
