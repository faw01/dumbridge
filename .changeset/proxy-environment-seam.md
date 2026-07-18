---
"dumbridge": patch
"@dumbridge/bridge-transport": patch
---

Thread the proxy environment through the bridge transport seam as a required value instead of an ambient `process.env` default, so a dial always reads the same environment the proxy commitment was made with. The proxy environment variable list now lives in one shared predicate consumed by both the client's transport selection and the doctor diagnosis.
