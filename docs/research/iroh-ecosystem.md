# Iroh ecosystem findings for dumbridge

Research date: 2026-07-14

## Recommendation

Build dumbridge v1 in TypeScript on the official `@number0/iroh` 1.0 Node binding, with one custom ALPN (`dumbridge/1`) and a small dumbridge wire protocol. Do **not** make Sendme, Dumbpipe, or `iroh-blobs` runtime dependencies for v1.

The intended composition is:

```text
dumbridge CLI
  -> capability-authenticated dumbridge protocol
  -> one Iroh connection + one bidirectional stream per invocation
  -> QUIC / NAT traversal / relay fallback supplied by Iroh
```

The main caveat is byte-copying in the current Node binding: stream methods expose `Array<number>`, and official tests convert with `Array.from(Buffer)` / `Buffer.from(...)`. Before promising large media or multi-gigabyte pulls, benchmark this path. If it is materially slow or memory-heavy, replace only the transport/transfer adapter with a narrow Rust addon or helper; keep the CLI, policy, protocol model, and Just Bash integration in TypeScript.

## Source snapshot

| Project | Observed version | Snapshot | Relevant fact |
| --- | --- | --- | --- |
| Iroh | 1.0.2 | [`5817271`](https://github.com/n0-computer/iroh/tree/5817271c4a5fedc3e8387ec788ed42d68ba22064) | Stable transport surface: endpoints, public-key identity, encrypted QUIC, concurrent streams, discovery, hole punching, relays. |
| Iroh FFI / Node | 1.0.0 | [`66e628e`](https://github.com/n0-computer/iroh-ffi/tree/66e628e0fd2b7d526d01b81269041c97fc97f7a5) | Official `@number0/iroh`; intentionally excludes higher-level protocols such as `iroh-blobs`. |
| `iroh-blobs` | 0.103.0 | [`e82cbdc`](https://github.com/n0-computer/iroh-blobs/tree/e82cbdcbdac9a78033174aad55e3199b2cf4c0dc) | Works with Iroh 1.0, but its own README says this line is not yet production quality. |
| Sendme | 0.36.0 | [`ee8d8d6`](https://github.com/n0-computer/sendme/tree/ee8d8d6570a73ab9864ca6bb79d29e36137f8e66) | Example application using Iroh 1.0 + `iroh-blobs` 0.103 for staged snapshot transfer. |
| Dumbpipe | 0.39.0 | [`7134237`](https://github.com/n0-computer/dumbpipe/tree/71342378ce8d6665d0c16ee093ff8e76397d8613) | Example application using Iroh 1.0 as a raw byte pipe. |

The local clones under `.repos/` include all five projects. `iroh-blobs` was initially inspected at its release commit and was then retained as an ignored local reference checkout.

## What Iroh hides—and what it does not

Iroh lets an application dial a peer by its public-key endpoint identity and then supplies authenticated encryption, QUIC streams and datagrams, path discovery, NAT traversal, and relay fallback. The official Iroh 1.0 README demonstrates the core client flow—`Endpoint`, `connect`, `open_bi`—and the Rust server-side `Router`/`ProtocolHandler` pattern. ([Iroh README](https://github.com/n0-computer/iroh/blob/5817271c4a5fedc3e8387ec788ed42d68ba22064/README.md))

Iroh does **not** define dumbridge's:

- filesystem authorization;
- bearer capability;
- request/response framing;
- command policy;
- output limits;
- file manifest or destination rules;
- revocation semantics.

ALPN selects and versions an application protocol. It is not authorization. Dumbpipe's default “handshake” is merely a fixed byte string, and its listener accepts whoever can reach the endpoint and speak the ALPN. ([Dumbpipe protocol constants](https://github.com/n0-computer/dumbpipe/blob/71342378ce8d6665d0c16ee093ff8e76397d8613/src/lib.rs), [accept loop](https://github.com/n0-computer/dumbpipe/blob/71342378ce8d6665d0c16ee093ff8e76397d8613/src/main.rs#L360-L423))

An Iroh `EndpointTicket` is also not an access grant. Its implementation serializes an `EndpointAddr`: endpoint ID plus address/relay hints. ([FFI ticket source](https://github.com/n0-computer/iroh-ffi/blob/66e628e0fd2b7d526d01b81269041c97fc97f7a5/src/ticket.rs)) The endpoint ID is a public Ed25519 key and must be treated as public.

## The Node binding is enough for a custom protocol

The official TypeScript surface exposes everything needed by dumbridge:

- `Endpoint.builder()` / `Endpoint.bind()`;
- configuring ALPNs and an optional secret key;
- `Endpoint.online()`, `addr()`, and `EndpointTicket`;
- `acceptNext()` on the provider;
- `connect()` on the client;
- `openBi()` / `acceptBi()`;
- bounded reads, exact reads, writes, resets, FINs, and connection close reasons.

See the generated [Node type declarations](https://github.com/n0-computer/iroh-ffi/blob/66e628e0fd2b7d526d01b81269041c97fc97f7a5/iroh-js/index.d.ts) and [endpoint implementation](https://github.com/n0-computer/iroh-ffi/blob/66e628e0fd2b7d526d01b81269041c97fc97f7a5/iroh-js/src/endpoint.rs).

Unlike Rust, the Node binding does not expose Iroh's `Router` or a `ProtocolHandler` trait. dumbridge should own one small accept loop:

```text
acceptNext
  -> optional cheap pre-handshake admission limit
  -> accept + connect
  -> acceptBi with timeout
  -> read bounded auth/request frame
  -> verify capability
  -> dispatch run | pull
```

That is not a reason to add another routing framework when dumbridge has one ALPN.

### Important byte-path risk

The generated declarations use `Array<number>` for read/write buffers. The binding's official tests use `Array.from(Buffer.from(...))` before writes and `Buffer.from(received)` after reads. ([Node endpoint tests](https://github.com/n0-computer/iroh-ffi/blob/66e628e0fd2b7d526d01b81269041c97fc97f7a5/iroh-js/test/endpoint.mjs)) Maintained community transports do the same conversion in 64 KiB chunks. ([Thunderbolt byte pump](https://github.com/thunderbird/thunderbolt/blob/26edce91fe1f14bae1d7b63fdbb70e83597ba0de/cli/src/iroh/pump.ts), [Iroh Cap'n Web framing](https://github.com/changesbyjames/iroh-capnweb/blob/67d875ecf1a2ead645e2945516318d936b1b1991/packages/node/src/index.ts))

This is acceptable for command output and ordinary files, but it is an unproven large-transfer path. A v1 tracer test should measure direct and relay transfer for roughly 1 KiB, 10 MiB, and 1 GiB payloads, including peak RSS.

## The dumbridge link must wrap the Iroh ticket

The best accountless pairing shape is an opaque bearer link containing:

```text
dumbridgeLinkV1
  version: 1
  endpointTicket: <Iroh EndpointTicket string>
  capability: <32 random bytes>
```

A suitable textual form is `dumbridge1_<base64url-encoded payload>`. JSON is adequate initially; a compact binary encoding can be introduced only if ticket length becomes a demonstrated problem. The served Mac path should not be encoded in the link. A non-sensitive display label is optional.

Why mint a link at all: the stateless cloud process must learn both **where and which cryptographic endpoint to dial** and **what grants access to this one served root**. Avoiding the link means introducing an account, registry, rendezvous name, persisted client identity, or interactive pairing service.

The server should bind the random capability to the in-memory `serve` process and its canonical root. It should compare the first frame in constant time before parsing a command or touching the filesystem. Ctrl-C closes the endpoint and destroys the only accepted capability, giving v1 revocation without a `revoke` command.

The link should normally be injected as a cloud secret/environment value rather than a command-line argument, since arguments are commonly logged and visible in process listings.

### Existing capability patterns

Three current implementations reinforce the separation between Iroh identity/addressing and application authorization:

1. Thunderbird's Thunderbolt persists each client's Iroh secret key, authenticates the resulting endpoint ID in the QUIC handshake, then checks a local allowlist before spawning an agent. It also caps handshakes, connection rates, idle stream waits, and live processes. ([endpoint setup](https://github.com/thunderbird/thunderbolt/blob/26edce91fe1f14bae1d7b63fdbb70e83597ba0de/cli/src/iroh/endpoint.ts), [admission and authorization](https://github.com/thunderbird/thunderbolt/blob/26edce91fe1f14bae1d7b63fdbb70e83597ba0de/cli/src/iroh/bridge.ts)) This is a good persistent-device pattern, but it is a poor first interaction for disposable cloud agents.
2. Boop defines an application `InviteTicket` that combines a 32-byte token with an Iroh `EndpointTicket`, then consumes the pending token on successful onboarding. ([invite ticket](https://github.com/olizilla/boop/blob/e73f219597d2cfcef1131e17926d998da0154f9b/src-tauri/boop-core/src/invite_ticket.rs), [welcome handler](https://github.com/olizilla/boop/blob/e73f219597d2cfcef1131e17926d998da0154f9b/src-tauri/boop-core/src/iroh_manager.rs)) This is closest to dumbridge's desired bearer-link shape, although Boop currently depends on release-candidate/older higher-level Iroh crates.
3. Volt wraps an Iroh ticket with protocol, endpoint identity, workspace, optional expiry, and a secret; after pairing it produces a reconnect ticket with secrets stripped. ([Volt ticket format](https://github.com/hansjm10/Volt/blob/bb5f8c44d4139bade4ef07152160dc1e19e831fb/packages/coding-agent/src/core/remote/iroh/ticket.ts)) Volt is much broader than dumbridge, but it demonstrates that the raw Iroh ticket and the application authorization token are distinct things.

For dumbridge v1, use the Boop-like bearer shape, not Thunderbolt/Volt's persisted-client lifecycle.

## Wire protocol shape

Use a single versioned ALPN: `dumbridge/1`. Keep `run` and `pull` as request variants within it rather than creating multiple network protocols.

Use explicit length-prefixed binary frames, with a hard maximum checked before allocation. Iroh's official framed-messages example uses a big-endian `u32` length and configures a maximum frame length specifically to prevent attacker-controlled buffering. ([framed-messages example](https://github.com/n0-computer/iroh-examples/blob/6a8cfcdccc6a633c5608cb25e776cb52fd509dd3/framed-messages/src/framed.rs))

One bidirectional stream per CLI invocation is sufficient:

```text
request:
  auth { capability }
  request { run | pull, bounded arguments }

run response:
  stdout { bytes } *
  stderr { bytes } *
  exit { code, truncated }

pull response:
  manifest { entries, sizes, types }
  file-start { path, size }
  file-chunk { bytes } *
  file-end { digest }
  complete
```

Do not put binary bytes into JSON/base64. A frame can have a small typed header and raw payload. Serialize writes per stream, propagate backpressure, and bound each of:

- initial auth/request frame;
- command length;
- stdout and stderr totals;
- manifest entries and total bytes;
- per-frame payload;
- command duration;
- handshake/stream-open duration;
- concurrent connections and pulls.

Thunderbolt and Iroh Cap'n Web are useful maintained Node references for serialized writes, bounded reads, connection shutdown, and backpressure. ([Thunderbolt pump](https://github.com/thunderbird/thunderbolt/blob/26edce91fe1f14bae1d7b63fdbb70e83597ba0de/cli/src/iroh/pump.ts), [Cap'n Web transport](https://github.com/changesbyjames/iroh-capnweb/blob/67d875ecf1a2ead645e2945516318d936b1b1991/packages/node/src/index.ts))

## What to borrow from Sendme

Sendme is valuable source material, not the right v1 dependency.

Its sender:

- canonicalizes the chosen path;
- walks directories and ignores symlinks;
- normalizes each relative name;
- imports files into an `iroh-blobs` store;
- creates a deterministic named collection;
- serves that collection through the `iroh-blobs` ALPN;
- prints a `BlobTicket` containing provider address, root hash, and blob format.

([Sendme import](https://github.com/n0-computer/sendme/blob/ee8d8d6570a73ab9864ca6bb79d29e36137f8e66/src/main.rs#L365-L484), [provider and ticket creation](https://github.com/n0-computer/sendme/blob/ee8d8d6570a73ab9864ca6bb79d29e36137f8e66/src/main.rs#L645-L775))

Its receiver downloads verified content into a hidden hash-named store, asks only for missing ranges when partial data already exists, loads the collection metadata, validates each path component, refuses existing destinations, exports the files, and removes staging. ([receive flow](https://github.com/n0-computer/sendme/blob/ee8d8d6570a73ab9864ca6bb79d29e36137f8e66/src/main.rs#L1008-L1143), [safe export paths](https://github.com/n0-computer/sendme/blob/ee8d8d6570a73ab9864ca6bb79d29e36137f8e66/src/main.rs#L486-L529))

dumbridge should copy the invariants, not the temporary blob database:

- every remote path is relative to one canonical served root;
- reject `..`, absolute paths, NULs, platform separator tricks, and root-escaping symlinks;
- deterministic directory manifests;
- no symlink following by default;
- stage cloud output before exposing the destination;
- refuse overwrite by default;
- verify byte count and digest before commit;
- clean staging on cancellation/failure.

Unlike Sendme, dumbridge serves a **live read-only root** and chooses artifacts after remote exploration. Importing the whole root into a content-addressed store at `serve` time would turn it into a stale snapshot and make startup proportional to the entire tree.

## Why not `iroh-blobs` in v1

`iroh-blobs` is technically well matched to reliable large transfer: it uses BLAKE3-verified streams, supports blobs and hash sequences, byte/chunk ranges, and calculating only missing ranges for partial local content. Its `Collection` stores names in metadata and children as content hashes. ([protocol design](https://github.com/n0-computer/iroh-blobs/blob/e82cbdcbdac9a78033174aad55e3199b2cf4c0dc/src/protocol.rs), [collection format](https://github.com/n0-computer/iroh-blobs/blob/e82cbdcbdac9a78033174aad55e3199b2cf4c0dc/src/format/collection.rs), [missing-range calculation](https://github.com/n0-computer/iroh-blobs/blob/e82cbdcbdac9a78033174aad55e3199b2cf4c0dc/src/api/remote.rs))

But it is the wrong v1 dependency for three concrete reasons:

1. The official FFI explicitly states that the bindings mirror the stabilized Iroh 1.0 transport surface and exclude higher-level protocols, including `iroh-blobs`, because those protocols are not yet at 1.0. ([Iroh FFI README](https://github.com/n0-computer/iroh-ffi/blob/66e628e0fd2b7d526d01b81269041c97fc97f7a5/README.md#L8-L17))
2. The current `iroh-blobs` 0.103 README says it is not yet considered production quality and points production users to the older 0.35 line. ([current README](https://github.com/n0-computer/iroh-blobs/blob/e82cbdcbdac9a78033174aad55e3199b2cf4c0dc/README.md#L1-L8))
3. A live filesystem path must still be imported/snapshotted into a blob store before it can be addressed by hash. dumbridge needs a custom authenticated command protocol regardless.

Revisit `iroh-blobs` only when resumable multi-gigabyte transfer is a demonstrated requirement and either a stable binding exists or a narrow Rust transfer adapter is justified.

## Why not spawn Sendme or Dumbpipe

Spawning either binary is viable for a throwaway connectivity spike, but neither removes dumbridge's hard parts.

### Dumbpipe subprocess

Dumbpipe would supply a byte pipe, but dumbridge would still need framing, bearer authentication, request limits, filesystem confinement, process supervision, cross-platform binary installation, and error translation. Its endpoint ticket is address information, and its fixed handshake is not authorization. It also exits after the first successful stdio connection in its basic mode. ([Dumbpipe stdio listener](https://github.com/n0-computer/dumbpipe/blob/71342378ce8d6665d0c16ee093ff8e76397d8613/src/main.rs#L360-L423))

The official `dumbpipe-web` example does not spawn a process: it embeds the `dumbpipe` crate for the ALPN/ticket/handshake and uses Iroh streams directly. ([dependency](https://github.com/n0-computer/iroh-examples/blob/6a8cfcdccc6a633c5608cb25e776cb52fd509dd3/dumbpipe-web/Cargo.toml), [connection code](https://github.com/n0-computer/iroh-examples/blob/6a8cfcdccc6a633c5608cb25e776cb52fd509dd3/dumbpipe-web/src/main.rs)) That is evidence for owning the transport integration rather than parsing a long-lived CLI.

### Sendme subprocess

Sendme can transfer a selected snapshot reliably, but it creates another endpoint/ticket and temporary store per selection. dumbridge would need to remotely ask the Mac to spawn it, scrape its human-oriented output, return a second ticket, supervise its lifetime, and align authorization between two unrelated protocols.

A real Raycast extension does spawn `sendme send`, searches several possible binary locations, parses both stdout and stderr for the human phrase `sendme receive`, stores the child process, and kills it later. ([Raycast Sendme wrapper](https://github.com/raycast/extensions/blob/5e98ea3fce2d4c487a59dfc2f5e3455a7d18564c/extensions/sendme/src/utils/sendme.ts)) That is workable UI glue, but it illustrates the integration cost dumbridge can avoid. The code searches performed for this report did not surface a comparably maintained Dumbpipe subprocess wrapper.

## Runtime and platform implications

The official npm package declares Node `>=20.3.0` and publishes native N-API targets for:

- macOS arm64;
- Linux x64 and arm64 (glibc and musl), plus armv7;
- Windows x64 and arm64;
- Android arm/arm64.

It does **not** currently list an Intel macOS target. ([package manifest](https://github.com/n0-computer/iroh-ffi/blob/66e628e0fd2b7d526d01b81269041c97fc97f7a5/iroh-js/package.json), [published target packages](https://github.com/n0-computer/iroh-ffi/tree/66e628e0fd2b7d526d01b81269041c97fc97f7a5/iroh-js/npm)) Official JavaScript CI runs Node, not Bun. ([JS CI](https://github.com/n0-computer/iroh-ffi/blob/66e628e0fd2b7d526d01b81269041c97fc97f7a5/.github/workflows/ci_js.yml))

Thunderbolt is useful evidence that `@number0/iroh` currently runs under Bun: its Bun-based CLI imports the package directly and implements a production-oriented Iroh bridge. ([CLI package](https://github.com/thunderbird/thunderbolt/blob/26edce91fe1f14bae1d7b63fdbb70e83597ba0de/cli/package.json), [endpoint integration](https://github.com/thunderbird/thunderbolt/blob/26edce91fe1f14bae1d7b63fdbb70e83597ba0de/cli/src/iroh/endpoint.ts)) This is community implementation evidence, not an upstream support contract. Thunderbolt's compiled CLI matrix currently covers macOS arm64 and Linux x64/arm64, not Windows.

Therefore:

- using Bun as package manager/test runner is low risk;
- advertising Bun as the required production runtime is premature;
- advertising a Bun single executable is premature until native-addon packaging is tested on every promised target;
- Node is the upstream-supported runtime baseline;
- “Mac, Linux, Windows” must be expressed as an explicit tested matrix, with Intel Mac excluded unless dumbridge builds its own addon target.

## Deep module consequences

Keep four modules visible at the architecture level:

1. **Bridge link module** — mints, encodes, decodes, and validates the versioned endpoint-plus-capability link. It hides Iroh ticket syntax and capability generation from every caller.
2. **Transport module** — owns `@number0/iroh` endpoint lifecycle, ALPN, accept/connect, deadlines, close behavior, chunk conversion, and backpressure. Its interface should expose a bounded byte session, not Iroh classes. The real Iroh adapter and an in-memory test adapter make this a real seam.
3. **Wire module** — owns framed request/response types and all size limits. Tests feed fragmented/coalesced frames through its public interface; callers never hand-roll framing.
4. **Pull module** — on the Mac, creates a safe manifest and reads bytes below the served root; in the cloud, stages, verifies, and commits destination files. It owns cross-platform path and overwrite semantics.

Do not create Sendme, Dumbpipe, and `iroh-blobs` adapters “just in case.” They are references, not varying production implementations. Adding those seams would make the interface as complicated as the implementation.

## Immediate proof points before the full build

These are implementation-risk checks, not new product features:

1. Bind an Apple Silicon Mac provider with `@number0/iroh`, mint an endpoint ticket, and connect from a Linux cloud container through both direct and relay paths.
2. Verify the exact `dumbridge1_…` capability handshake, wrong-token rejection, Ctrl-C revocation, handshake timeout, stream-open timeout, and connection cap.
3. Round-trip deliberately fragmented/coalesced frames and binary bytes containing every value `0x00..0xff`.
4. Benchmark `Array<number>` conversion and streaming at 1 KiB, 10 MiB, and 1 GiB; record throughput and peak RSS under Node and Bun.
5. Test native package installation and a real pull on macOS arm64, Linux x64 glibc, Linux x64 musl, Windows x64, and Windows arm64 if it will be promised.
6. Pull a mutating source file and choose the contract: fail when size/mtime changes, or explicitly snapshot it. Do not silently return a mixed version.

If those pass, the direct TypeScript binding is the smallest architecture. If only the large-transfer benchmark fails, deepen the transport module by replacing its implementation with a narrow Rust/N-API byte adapter; do not rewrite the product around Sendme.
