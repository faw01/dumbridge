---
"dumbridge": patch
---

Pin `@effect/platform-node-shared` to the exact `effect` beta so fresh installs stop warning about an incorrect peer dependency. `@effect/platform-bun` reaches it through a caret range that floats to newer betas whose `effect` peer range the pinned beta no longer satisfies; the explicit pin keeps the whole `@effect` graph on one `effect` instance.
