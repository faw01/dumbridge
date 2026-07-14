# Initial runtime and CLI research: Node, Bun, Effect, Iroh, and Just Bash

Date: 2026-07-14

> **Superseded decision.** This document preserves the initial Node recommendation. The owner subsequently chose Bun as Dumbridge's published runtime with `@effect/platform-bun`. The [Bun and Iroh ADR](../adr/0002-use-bun-and-iroh.md) and [v1 design](../design/v1.md) are authoritative.

## Initial recommendation

Use this stack for Dumbridge v1:

- **Language:** TypeScript.
- **Published/runtime contract:** Node.js, with `#!/usr/bin/env node` and `engines.node: ">=22"`.
- **Development package manager:** Bun is fine; using `bun install` does not require publishing a Bun-only CLI.
- **Effect:** Effect v4 beta, pinned to one exact beta across `effect` and `@effect/platform-node`.
- **CLI parser:** the v4 module at `effect/unstable/cli`, not the separate `@effect/cli` package.
- **Network transport:** `@number0/iroh` directly.
- **Remote read shell:** `just-bash` directly on the serving machine.
- **Distribution:** an ordinary npm package invoked with `npx dumbridge`; do not start with Bun standalone executables.

Node is the recommended runtime because `@number0/iroh@1.0.0` explicitly declares Node `>=20.3.0`, while Bun implements only most—not all—of Node-API. Node 24 is Active LTS as of this report, Node 22 remains Maintenance LTS, and Node 20 is EOL; therefore Dumbridge should support Node 22 and 24 rather than merely copying Iroh's now-EOL minimum. [Iroh published manifest](https://github.com/n0-computer/iroh-ffi/blob/66e628e0fd2b7d526d01b81269041c97fc97f7a5/iroh-js/package.json) · [Node release schedule](https://github.com/nodejs/Release#release-schedule) · [Bun Node-API documentation](https://bun.sh/docs/runtime/node-api)

Bun remains useful for installing dependencies and running repository scripts. That choice is independent from the runtime named in the package's shebang and `engines` field.

## The current Effect split matters

There are two valid but incompatible Effect product lines on npm right now:

| Line | Core package | CLI import | Platform package |
| --- | --- | --- | --- |
| Stable Effect 3 | `effect@3.22.0` | `@effect/cli@0.76.0` | stable `@effect/platform-node` / `@effect/platform-bun` |
| Effect 4 beta | `effect@4.0.0-beta.98` | `effect/unstable/cli` | `@effect/platform-node@4.0.0-beta.98` or `@effect/platform-bun@4.0.0-beta.98` |

These versions were read from the npm registry on 2026-07-14. The standalone `@effect/cli@0.76.0` declares peer dependencies on Effect 3 (`effect ^3.22.0` and `@effect/platform ^0.97.0`), so installing it beside Effect 4 is the wrong combination. [Effect package](https://www.npmjs.com/package/effect?activeTab=versions) · [`@effect/cli`](https://www.npmjs.com/package/%40effect/cli?activeTab=versions)

Effect Solutions is teaching the Effect 4 line: its CLI guide installs `effect@beta` plus a beta platform package and imports `Argument`, `Command`, and `Flag` from `effect/unstable/cli`. For Node it explicitly says to use `@effect/platform-node@beta`; for Bun it uses `@effect/platform-bun@beta`. [Effect Solutions CLI guide](https://www.effect.solutions/cli)

Therefore, if Dumbridge follows Effect Solutions—as intended—its dependencies should look conceptually like:

```json
{
  "dependencies": {
    "effect": "4.0.0-beta.98",
    "@effect/platform-node": "4.0.0-beta.98"
  }
}
```

Pin the exact beta and update all Effect packages together. Effect's `beta` tag has moved quickly, and the published `effect-solutions@0.5.3` tool itself still pins beta.59 internally. Treat Effect Solutions as a development/reference tool, not a runtime dependency of Dumbridge. Its package also declares `bun >=1.1.0`, so cloning it under `.repos/` avoids making Bun a prerequisite merely to run Dumbridge. [Effect Solutions package manifest](https://github.com/kitlangton/effect-solutions/blob/09f82e6c5c928e7232cd32daf04d7c6a830b63f7/packages/cli/package.json)

The supplied Effect setup prompt says CLI applications should always install `@effect/cli`. That is correct for Effect 3, but it conflicts with the Effect 4 guidance on the current Effect Solutions CLI page. Dumbridge must choose one line rather than combine them.

## Why Effect CLI does fit Dumbridge

There is no conflict between Effect CLI, Just Bash, and Iroh. They parse or manage different things:

```text
effect/unstable/cli parses:  dumbridge run '<script>'
Iroh carries:                a typed Run request containing <script>
Just Bash parses on the Mac: <script>
```

For example:

```bash
dumbridge run 'rg -n "TODO" . | head -50'
```

Effect CLI sees a `run` subcommand and one string argument. It does not see `rg`'s `-n` flag because the shell has already kept the quoted script together. Just Bash interprets that inner script after it reaches the serving machine.

Effect is useful here for real lifecycle complexity, not only pretty argument parsing:

- `serve` acquires an Iroh endpoint and guarantees `endpoint.close()` on Ctrl-C or failure.
- the accept loop can supervise each connection in its own fiber.
- request timeouts, cancellation, retries, and typed transport errors remain local to one module.
- `run` can wrap `bash.exec()` and `pull` can wrap Iroh stream operations without leaking promises through every caller.

The deep external interface can stay small:

```ts
serve(root): Effect<never, ServeError, Scope>
run(script): Effect<RunResult, RunError>
pull(path): Effect<PulledFile, PullError>
```

Internally, Iroh and Just Bash are adapters at two separate seams. Neither needs to know Effect exists.

### Do not model `run` as arbitrary CLI argv yet

An isolated probe against `effect@4.0.0-beta.98` found this behavior on both Node and Bun:

```text
dumbridge run rg -n foo .       -> rejected: `-n` is an unknown Dumbridge flag
dumbridge run -- rg -n foo .    -> exits successfully, but the run handler receives []
dumbridge run 'rg -n foo .'     -> handler receives ["rg -n foo ."]
```

The beta lexer's source says tokens after `--` become trailing operands, but its recursive subcommand parser currently leaves those operands at the parent command instead of forwarding them into the selected child. This is an observed beta limitation, not a conceptual incompatibility. [Effect 4.0.0-beta.98 lexer source](https://unpkg.com/effect@4.0.0-beta.98/src/unstable/cli/internal/lexer.ts) · [Effect 4.0.0-beta.98 parser source](https://unpkg.com/effect@4.0.0-beta.98/src/unstable/cli/internal/parser.ts)

For v1, define `run` as one required script string. This is also the most honest interface because Dumbridge is deliberately offering shell syntax—pipes, redirection, globs, and quoting—not merely spawning a process with an argv array.

## Bun versus Node

| Concern | Node runtime | Bun runtime |
| --- | --- | --- |
| Official Iroh package contract | Explicitly supported (`node >=20.3`) | Not declared by Iroh |
| Native addon model | Node-API is Node's stable ABI | Bun reimplements Node-API; its docs report broad but incomplete compatibility |
| `npx dumbridge` | Natural | Would still need Node, or a separate Bun/bootstrap strategy |
| TypeScript execution | Compile to JS for publication | Runs TypeScript directly |
| Effect v4 runtime | `@effect/platform-node@beta` | `@effect/platform-bun@beta` |
| Standalone binaries | Requires another packager | Built in with `bun build --compile` |
| Risk | Conservative and matches the native package contract | Additional compatibility layer across every OS/architecture |

Bun supports macOS, Linux, and Windows and can embed a directly required `.node` addon in a standalone executable. [Bun installation matrix](https://bun.sh/docs/installation) · [Bun standalone executable documentation](https://bun.sh/docs/bundler/executables)

However, `@number0/iroh` uses a generated NAPI-RS loader plus platform-specific optional packages. A same-platform Bun executable worked in the probe, but a macOS-to-Linux cross-compile contained loader branches that reported the Linux Iroh packages as unresolved because only the host's Darwin optional dependency had been installed. A production binary release would therefore need native CI jobs—or an explicitly target-aware install/build process—for every target. An npm package lets the user's package manager select the correct optional native package at install time, which is substantially simpler for v1.

The same-platform probe executable was also 76 MiB before any product code. That is not inherently bad, but it removes the main simplicity advantage of publishing a small JavaScript CLI through npm.

## Compatibility probe

The following was tested in a throwaway directory; no Dumbridge product code was scaffolded.

Environment:

```text
macOS arm64
Bun 1.3.14
Node 22.22.2
@number0/iroh 1.0.0
just-bash 3.1.0
effect 4.0.0-beta.98
@effect/platform-bun 4.0.0-beta.98
@effect/platform-node 4.0.0-beta.98
```

Results:

| Probe | Node | Bun |
| --- | --- | --- |
| Import `@number0/iroh` native addon | Pass | Pass |
| `Endpoint.builder()` + minimal preset + bind | Pass | Pass |
| Create and parse an endpoint ticket | Pass | Pass |
| Close endpoint | Pass | Pass |
| Just Bash `cat | rg` pipeline | Pass | Pass |
| Effect v4 CLI with platform services | Pass | Pass |
| Quoted `run` script preserved as one argument | Pass | Pass |
| Same-platform Bun standalone with Iroh | N/A | Pass |

This demonstrates that Bun is technically viable on this machine. It does not promote Bun to an officially supported Iroh runtime, and it does not prove Linux or Windows behavior.

One additional packaging rough edge surfaced: `@number0/iroh@1.0.0` currently points its `main` field at `iroh-js/index.js`, while the published tarball places `index.js` at its root. Node falls back to that root file and emits `DEP0128` when resolving the package directly. Ordinary default imports worked in both probes, but Dumbridge should add an install/import smoke test so an upstream packaging regression is caught immediately. [Published Iroh package](https://www.npmjs.com/package/%40number0/iroh)

## What Iroh 1.0 exposes—and omits

The Node binding exposes the stabilized Iroh 1.0 surface: endpoints, endpoint tickets, QUIC connections, unidirectional and bidirectional streams, relays, paths, and services. It intentionally excludes the higher-level `iroh-blobs`, `iroh-docs`, and `iroh-gossip` protocols because those are not yet in the binding's stabilized 1.0 scope. [iroh-ffi scope](https://github.com/n0-computer/iroh-ffi/blob/66e628e0fd2b7d526d01b81269041c97fc97f7a5/README.md) · [generated JavaScript types](https://github.com/n0-computer/iroh-ffi/blob/66e628e0fd2b7d526d01b81269041c97fc97f7a5/iroh-js/index.d.ts)

That omission does not block Dumbridge. `run` needs a small framed request/response protocol over an Iroh bidirectional stream, and `pull` can initially stream bytes plus length/hash metadata over another stream. Adopting `iroh-blobs` would require either:

1. a Dumbridge-owned Rust addon that binds the blobs protocol, or
2. spawning a Rust binary such as Sendme.

Both are reasonable later if resumable, content-addressed multi-gigabyte transfer becomes a product requirement. They add packaging and lifecycle complexity without helping the first source-file/skill/image use cases.

## Platform support we can honestly promise

The published `@number0/iroh@1.0.0` optional dependencies define the real native support matrix, not TypeScript's portability:

| Host | Published Iroh binary | Dumbridge v1 position |
| --- | --- | --- |
| macOS arm64 | Yes | Support |
| macOS x64 | No published optional package | Do not promise initially |
| Linux x64 glibc | Yes | Support and test |
| Linux x64 musl | Yes | Support and test |
| Linux arm64 glibc | Yes | Support and test |
| Linux arm64 musl | Yes | Support and test |
| Windows x64 MSVC | Yes | Support and test |
| Windows arm64 MSVC | Yes | Support after CI proves it |
| Linux armv7 | Published glibc/musl packages | Defer unless demanded |

The source manifest also lists Android targets, but Android is not a useful v1 CLI promise. [Iroh Node package targets](https://github.com/n0-computer/iroh-ffi/blob/66e628e0fd2b7d526d01b81269041c97fc97f7a5/iroh-js/package.json)

Just Bash is TypeScript and publishes ESM, CommonJS, and browser entrypoints, but it remains explicitly marked beta. Its `OverlayFs` provides copy-on-write access over a real root, and its threat model identifies the script author as untrusted. Dumbridge should depend on that small filesystem/execution interface and protect it with end-to-end contract tests, especially on Windows path and symlink behavior. [Just Bash manifest](https://github.com/vercel-labs/just-bash/blob/6130334f0ed013771bbe39f32a249bdaf762c488/packages/just-bash/package.json) · [Just Bash filesystem documentation](https://github.com/vercel-labs/just-bash/blob/6130334f0ed013771bbe39f32a249bdaf762c488/packages/just-bash/README.md#filesystem-options) · [Just Bash threat model](https://github.com/vercel-labs/just-bash/blob/6130334f0ed013771bbe39f32a249bdaf762c488/THREAT_MODEL.md)

Before claiming cross-platform support, CI should run the real tracer bullet on each promised runner:

1. install the published package;
2. load the native Iroh addon;
3. bind two local endpoints;
4. execute one Just Bash read against a temporary served root;
5. transfer one binary file and verify its hash;
6. interrupt `serve` and prove the endpoint closes.

## Bottom line

Use Effect CLI. Its job is valuable and it does not conflict with Just Bash or Iroh. Use the Effect 4 version that Effect Solutions actually documents (`effect/unstable/cli`), keep `run` as one quoted script string, and let Effect own process lifecycle and errors.

Use Node as the shipped runtime because it matches Iroh's explicit contract and preserves the desired `npx dumbridge` experience. Use Bun for development if preferred. Reconsider Bun-native standalone binaries only after the npm CLI works and a native CI release matrix proves every Iroh target.
