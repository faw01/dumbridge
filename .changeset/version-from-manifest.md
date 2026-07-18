---
"dumbridge": patch
---

Report the installed package's version from its manifest at startup instead of a constant inlined at bundle time, so `--version` stays truthful when a release or prerelease re-versions `package.json` after `dist/cli.js` was built. The tarball verification now proves it.
