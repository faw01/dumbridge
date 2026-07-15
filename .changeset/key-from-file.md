---
"dumbridge": minor
---

Accept the bridge key from a file or stdin: `run` and `pull` gain `--key-file <path>` (`-` reads stdin), which wins over the still-supported `DUMBRIDGE_KEY` environment variable; empty or multi-line key files are refused with branded messages that never echo their content, and every CLI error message is scrubbed of bridge-key-shaped tokens before printing.
