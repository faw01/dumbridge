# Cloud connectivity: can dumbridge actually reach a Mac?

Date: 2026-07-14

## Bottom line

The current TypeScript plan — `@number0/iroh` directly from the cloud CLI — is **not sufficient for Codex cloud**. Codex cloud sends all outbound internet traffic through an HTTP/HTTPS proxy, while the current `@number0/iroh` JavaScript binding does not expose Iroh's proxy configuration. Setting `HTTP_PROXY` alone therefore does not alter `Endpoint.bind()` in JavaScript.

The underlying Rust Iroh transport is closer than it first appears: its relay path is WSS over TCP, and Rust Iroh can tunnel that connection through an HTTP/HTTPS proxy using HTTP `CONNECT`. A small binding addition could make a relay-only dumbridge connection possible from Codex cloud. This remains a **must-prove integration**, because OpenAI documents domain/method filtering but does not promise that arbitrary long-lived WebSocket tunnels are accepted by the cloud egress proxy.

Cursor-managed Cloud Agents are a better fit. Cursor documents outbound modes ranging from domain allowlists to access to any external host. Its docs do not specify UDP/QUIC or WebSocket behavior, so direct Iroh is plausible—not proven—but the WSS relay path gives it a strong fallback when UDP is unavailable.

| Cloud runtime | Current `@number0/iroh` | Iroh with proxy exposed | Credential placement |
| --- | --- | --- | --- |
| Codex cloud | **No** under the documented proxy-only egress model | **Plausible, test required**; force relay/WSS and use the environment's HTTP proxy | `DUMBRIDGE_LINK` must be an environment variable; Codex secrets disappear before the agent phase |
| Cursor-managed Cloud Agent | **Plausible, test required** when the relay host is allowed | Also works if Cursor later requires an explicit proxy | Cursor secrets are exposed to the agent as environment variables, which is exactly where the CLI needs the link |
| Cursor self-hosted / My Machines | Depends on the user's host network | Yes, if that network requires a proxy | Controlled by the user's infrastructure |

## Codex cloud constraints

Codex creates an isolated container, runs setup, and then applies the environment's agent internet policy. Agent internet is off by default; when enabled, the user can restrict both domains and HTTP methods. The most restrictive documented method set is `GET`, `HEAD`, and `OPTIONS`. See [Cloud environments](https://developers.openai.com/codex/cloud/environments) and [Agent internet access](https://developers.openai.com/codex/cloud/agent-internet).

More importantly, OpenAI states that Codex cloud environments run behind an HTTP/HTTPS network proxy and that **all outbound internet traffic passes through it**. That makes a normal UDP/QUIC socket unusable as the only path. An Iroh client must be able to fall back to a relay reachable through the proxy.

### Environment variables versus secrets

OpenAI documents two distinct lifetimes:

- Environment variables exist during setup **and** the agent phase.
- Secrets are decrypted for setup, then removed before the agent phase.

The cloud agent itself runs `dumbridge`, so the capability cannot be stored only as a Codex secret. For V1 it must be supplied as a task-long environment variable such as `DUMBRIDGE_LINK`. Writing a Codex secret into a file during setup would merely defeat the documented secret boundary and should not be the recommended flow.

This makes link lifetime and scope important: mint it shortly before the task, bind it to one shared root, make it read-only, and expire it when `dumbridge serve` stops. Never log it.

### Installation timing

The setup phase has internet access, so the environment can install dumbridge once there. Relying on `npx` to download the package during the agent phase would additionally require `npmjs.com`/the npm registry to be permitted. Prefer an environment setup step that installs the pinned CLI; during the task, `dumbridge run` and `dumbridge pull` should need only the Iroh relay host.

## What Iroh can do through a proxy

The Rust `iroh::endpoint::Builder` has both `proxy_url` and `proxy_from_env`; the latter reads `HTTP_PROXY`, `http_proxy`, `HTTPS_PROXY`, then `https_proxy`. See the current [Iroh endpoint builder source](https://github.com/n0-computer/iroh/blob/5817271c4a5fedc3e8387ec788ed42d68ba22064/iroh/src/endpoint.rs#L689-L703) and [generated Rust docs](https://docs.rs/iroh/latest/iroh/endpoint/struct.Builder.html#method.proxy_from_env).

Iroh's relay connection is not UDP. It converts an HTTPS relay URL to `wss://.../relay`, opens a WebSocket, and carries the Iroh packets inside it. See [relay client construction](https://github.com/n0-computer/iroh/blob/5817271c4a5fedc3e8387ec788ed42d68ba22064/iroh-relay/src/client.rs#L267-L296). When a proxy is configured, Iroh connects to that proxy, issues HTTP `CONNECT` for the relay host and port, then performs TLS and the WebSocket upgrade inside that tunnel; see [proxy dialing](https://github.com/n0-computer/iroh/blob/5817271c4a5fedc3e8387ec788ed42d68ba22064/iroh-relay/src/client/tls.rs#L113-L225).

That gives dumbridge a viable constrained mode:

1. The Mac starts Iroh normally and waits until it has a relay address.
2. The dumbridge link includes a **relay-only** endpoint ticket: endpoint ID plus one HTTPS relay URL, not direct IP addresses.
3. The cloud client applies Iroh's minimal preset plus a custom relay map containing that ticket's relay.
4. On Codex, the cloud client calls `proxy_from_env` (or receives an explicit proxy URL) and stays relayed. It does not depend on UDP hole punching.

The default Number 0 relays currently live at these hosts: `use1-1.relay.n0.iroh.link`, `usw1-1.relay.n0.iroh.link`, `euc1-1.relay.n0.iroh.link`, and `aps1-1.relay.n0.iroh.link`; see [Iroh's production defaults](https://github.com/n0-computer/iroh/blob/5817271c4a5fedc3e8387ec788ed42d68ba22064/iroh/src/defaults.rs#L19-L78). A restrictive cloud environment should allow the exact relay hosts it may receive. The Codex "Common dependencies" preset does not currently include `iroh.link`, so dumbridge must document this extra allowlist step.

### The current JavaScript binding gap

The current `@number0/iroh` builder exposes presets, secret key, ALPNs, relay mode, bind address, and bind, but not `proxyUrl` or `proxyFromEnv`; see the [N-API endpoint builder](https://github.com/n0-computer/iroh-ffi/blob/66e628e0fd2b7d526d01b81269041c97fc97f7a5/iroh-js/src/endpoint.rs#L45-L108). `Endpoint.bind()` applies the N0 preset and binds directly; it never opts into environment proxy discovery ([source](https://github.com/n0-computer/iroh-ffi/blob/66e628e0fd2b7d526d01b81269041c97fc97f7a5/iroh-js/src/endpoint.rs#L249-L306)).

Therefore:

- `HTTP_PROXY=... npx dumbridge ...` does **not** fix Codex connectivity with the unmodified package.
- A tiny upstreamable binding change (`proxyUrl`, `proxyFromEnv`) is needed if the CLI stays TypeScript.
- dumbridge should use a fork only temporarily and submit the surface upstream, because maintaining a full native-package matrix merely for two forwarding methods is poor leverage.

Spawning today's `dumbpipe` or `sendme` does not avoid the gap. Both use Rust Iroh, but neither opts into `proxy_from_env` when constructing its endpoint: [dumbpipe](https://github.com/n0-computer/dumbpipe/blob/71342378ce8d6665d0c16ee093ff8e76397d8613/src/main.rs#L302-L318), [sendme](https://github.com/n0-computer/sendme/blob/ee8d8d6570a73ab9864ca6bb79d29e36137f8e66/src/main.rs#L648-L669). Forking either with one extra builder call could serve as a connectivity spike, but it is not a complete dumbridge protocol.

## Cursor Cloud Agent constraints

Cursor documents three managed network modes: allow any external host, default domains plus an allowlist, or allowlist-only. See [Cloud Agent Security & Network](https://cursor.com/docs/cloud-agent/security-network). Cursor also recommends managing agent credentials through its Secrets settings, which exposes them as environment variables to the agent; see [Cloud Agent setup](https://cursor.com/docs/cloud-agent/setup).

This is materially easier than Codex:

- In "Allow all", the current binding may establish direct UDP paths or WSS relay paths.
- In an allowlisted environment, permit the relay host(s). The relay path is hostname-based WSS on port 443.
- Cursor's official docs do not state whether hosted VMs allow UDP, QUIC, WebSocket upgrades, or arbitrary TCP in each mode. Treat all of those as unverified until a real Cloud Agent probe succeeds.
- For self-hosted agents, a worker makes an outbound HTTPS connection to Cursor while tool execution happens in the user's infrastructure, so dumbridge inherits that infrastructure's own network reachability; see [Self-Hosted Agents](https://cursor.com/docs/cloud-agent/self-hosted-pool).

Store the short-lived `DUMBRIDGE_LINK` as a Cursor secret scoped to the relevant environment/repository. It will be visible to commands run by the agent; that is required for the CLI, but it also means the link must be treated as a bearer capability rather than a permanent machine credential.

## What `openai/tunnel-client` teaches us

`openai/tunnel-client` avoids this entire class of cloud-egress surprises by making the private-side process initiate outbound HTTPS to an OpenAI control plane. It long-polls for queued work and posts responses back; the private service needs no public listener. The official [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) documents the network path, runtime API-key authentication, org/workspace permissions, outbound proxy support, custom CAs, mTLS, and loopback-only admin UI defaults.

The cloned implementation reinforces several good dumbridge rules:

- outbound-only networking, with no inbound firewall rule;
- explicit authentication separate from an endpoint identifier;
- bounded inflight work and backpressure;
- proxy configuration and standard proxy-environment fallback;
- local operations endpoints bound to loopback by default;
- raw HTTP/body logging off by default.

See the pinned [architecture](https://github.com/openai/tunnel-client/blob/baaea561a4a006d71e8b142e3826925d74e1316a/docs/architecture.md#L1-L19), [security defaults](https://github.com/openai/tunnel-client/blob/baaea561a4a006d71e8b142e3826925d74e1316a/docs/architecture.md#L115-L125), and [proxy deployment guidance](https://github.com/openai/tunnel-client/blob/baaea561a4a006d71e8b142e3826925d74e1316a/docs/deployment/overview.md#L41-L59).

It is not a drop-in transport for the desired CLI. It is OpenAI-specific, account/RBAC-backed, and forwards MCP/allowlisted HTTP callouts through OpenAI's hosted service. dumbridge wants an agent-agnostic shell-facing CLI. We should borrow its outbound-only and credential-handling design, not wrap its protocol.

## Recommended V1 decision

Keep Iroh, but make **relay-over-proxy a release gate**, not an assumption.

1. Add `proxyUrl` and `proxyFromEnv` to a narrow dumbridge fork of the Iroh Node binding and open the same change upstream.
2. Generate relay-only dumbridge links for cloud use.
3. On the cloud side, build the endpoint from the minimal preset plus the ticket's relay, avoiding the N0 discovery services and unrelated domains.
4. Install dumbridge during each provider's environment setup.
5. Document provider-specific setup:
   - Codex: enable agent internet; allow the exact Iroh relay host(s); begin with `GET`, `HEAD`, and `OPTIONS`; put `DUMBRIDGE_LINK` in an environment variable, not a Codex secret.
   - Cursor: allow the relay host(s); put `DUMBRIDGE_LINK` in a scoped Cursor secret.
6. If Codex's proxy rejects Iroh's WebSocket/`CONNECT` flow, do not keep adding transport tricks. Introduce an HTTPS long-poll fallback behind the same dumbridge protocol boundary, modeled on tunnel-client. That fallback would require a tiny hosted broker, so it should be evidence-driven.

The CLI and application protocol should not know whether bytes arrived over direct QUIC, Iroh's WSS relay, or a future HTTPS queue. A `BridgeTransport` seam should expose only connect, request, response stream, and close. That is the smallest interface that keeps this provider-specific networking out of `serve`, `run`, and `pull`.

## Required real-environment proof

Before calling V1 cross-cloud, run the following matrix in actual hosted agents, not just local containers:

| Check | Codex cloud | Cursor managed |
| --- | --- | --- |
| CLI installed during setup | Required | Required |
| Capability present during agent phase | Environment variable | Scoped secret/env var |
| Restrictive relay-domain allowlist | Required | Required |
| Iroh endpoint reaches relay | Must pass through proxy | Must pass |
| Path reports `relay`, not direct IP | Expected | Record actual path |
| `run 'pwd; find ...'` round trip | Must pass | Must pass |
| Pull 1 byte, 1 MiB, and 100 MiB | Must pass | Must pass |
| Link redacted from logs/errors | Must pass | Must pass |
| Server stop immediately invalidates link | Must pass | Must pass |

For Codex, repeat once with only `GET`/`HEAD`/`OPTIONS` allowed and once unrestricted. If the first fails and the second succeeds, inspect whether the egress policy is rejecting the proxy `CONNECT` or WebSocket upgrade before changing the product design.

## Sources and version notes

Primary sources only were used: current OpenAI and Cursor product documentation plus local clones pinned to `iroh` `5817271`, `iroh-ffi` `66e628e`, `dumbpipe` `7134237`, `sendme` `ee8d8d6`, and `openai/tunnel-client` `baaea56`. Product network behavior can change; rerun the hosted-agent matrix before each major release.
