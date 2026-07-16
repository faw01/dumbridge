import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { Endpoint, RelayMode } from "@number0/iroh";
import { Effect } from "effect";
import type { DiagnosisCheck } from "../index";
import {
  configureIrohProxy,
  hasProxyEnvironment,
  type ProxyEnvironment,
} from "./proxy";

// Network and binding effects stay behind this seam so the diagnosis
// composition never touches a real socket in tests. Each probe owns its own
// timeout and settles either way; a rejection is the "unreachable" signal.
export interface IrohDiagnosticProbes {
  readonly makeEndpointBuilder: () => object;
  readonly openTcp: (host: string, port: number) => Promise<void>;
  readonly resolveHost: (host: string) => Promise<void>;
  readonly sendUdpProbe: () => Promise<void>;
}

// The environment is a value threaded in from the CLI shell; this module
// never reads the ambient process environment itself.
export interface IrohDiagnosisRequest {
  readonly environment: ProxyEnvironment;
  readonly probes: IrohDiagnosticProbes;
  readonly relayHosts: readonly string[];
}

const succeeds = (run: () => Promise<void>): Effect.Effect<boolean> =>
  Effect.tryPromise({ catch: () => undefined, try: run }).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false))
  );

const partitionHosts = (
  hosts: readonly string[],
  probe: (host: string) => Promise<void>
) =>
  Effect.all(
    hosts.map((host) =>
      succeeds(() => probe(host)).pipe(
        Effect.map((reached) => ({ host, reached }))
      )
    ),
    { concurrency: "unbounded" }
  ).pipe(
    Effect.map((results) => ({
      reached: results
        .filter((result) => result.reached)
        .map((result) => result.host),
      unreached: results
        .filter((result) => !result.reached)
        .map((result) => result.host),
    }))
  );

// An empty host list means the binding exposed no default relay
// configuration (or reading it crashed); reporting "all 0 ok" would let
// doctor exit clean without probing anything.
const emptyRelayHostsDetail =
  "No iroh relay hosts could be read from the installed binding's default relay configuration.";

const dnsCheck = (request: {
  readonly probes: IrohDiagnosticProbes;
  readonly relayHosts: readonly string[];
}): Effect.Effect<DiagnosisCheck> =>
  partitionHosts(request.relayHosts, request.probes.resolveHost).pipe(
    Effect.map(({ reached, unreached }) => {
      const name = "dns-resolution";
      const total = request.relayHosts.length;
      if (total === 0) {
        return {
          detail: emptyRelayHostsDetail,
          name,
          status: "fail" as const,
        };
      }
      if (unreached.length === 0) {
        return {
          detail: `Resolved all ${total} iroh relay hosts: ${reached.join(", ")}.`,
          name,
          status: "ok" as const,
        };
      }
      if (reached.length === 0) {
        return {
          detail: `Could not resolve any of the ${total} iroh relay hosts: ${unreached.join(", ")}.`,
          name,
          status: "fail" as const,
        };
      }
      return {
        detail: `Resolved ${reached.length} of ${total} iroh relay hosts; could not resolve: ${unreached.join(", ")}.`,
        name,
        status: "warn" as const,
      };
    })
  );

const udpCheck = (
  probes: IrohDiagnosticProbes
): Effect.Effect<DiagnosisCheck> =>
  succeeds(probes.sendUdpProbe).pipe(
    Effect.map((answered) => ({
      detail: answered
        ? "A UDP datagram to a public DNS resolver was answered; UDP egress and a return path are available, so direct peer-to-peer connections may be possible."
        : "No reply to a UDP datagram sent to a public DNS resolver; UDP egress looks blocked, so sessions will depend on the relay path.",
      name: "udp-egress",
      status: answered ? ("ok" as const) : ("warn" as const),
    }))
  );

const relayPort = 443;

const relayCheck = (request: {
  readonly probes: IrohDiagnosticProbes;
  readonly proxyUsable: boolean;
  readonly relayHosts: readonly string[];
}): Effect.Effect<DiagnosisCheck> =>
  partitionHosts(request.relayHosts, (host) =>
    request.probes.openTcp(host, relayPort)
  ).pipe(
    Effect.map(({ reached, unreached }) => {
      const name = "relay-reachability";
      const total = request.relayHosts.length;
      if (total === 0) {
        return {
          detail: emptyRelayHostsDetail,
          name,
          status: "fail" as const,
        };
      }
      if (unreached.length === 0) {
        return {
          detail: `All ${total} iroh relay hosts accepted a TCP connection on port ${relayPort}.`,
          name,
          status: "ok" as const,
        };
      }
      if (reached.length > 0) {
        return {
          detail: `${reached.length} of ${total} iroh relay hosts accepted a TCP connection on port ${relayPort}; unreachable: ${unreached.join(", ")}.`,
          name,
          status: "warn" as const,
        };
      }
      // In a proxy-only sandbox a direct TCP connection is expected to be
      // refused; relay bytes can still travel through the HTTP(S) proxy, but
      // only when the installed binding can actually use that proxy. Probing
      // through the proxy would mean speaking HTTP CONNECT here — a parallel
      // probing stack — so the detail names the untested path instead.
      if (request.proxyUsable) {
        return {
          detail: `No iroh relay host accepted a direct TCP connection on port ${relayPort}; with an HTTP(S) proxy configured, relay traffic must travel through the proxy, a path this probe does not test.`,
          name,
          status: "warn" as const,
        };
      }
      return {
        detail: `No iroh relay host accepted a TCP connection on port ${relayPort}: ${unreached.join(", ")}.`,
        name,
        status: "fail" as const,
      };
    })
  );

const proxyCheck = (request: {
  readonly environment: ProxyEnvironment;
  readonly probes: IrohDiagnosticProbes;
}): Effect.Effect<DiagnosisCheck> => {
  const name = "proxy-capability";
  if (!hasProxyEnvironment(request.environment)) {
    return Effect.succeed({
      detail: "No HTTP(S) proxy is configured in the environment.",
      name,
      status: "ok" as const,
    });
  }
  // The capability probe is the existing proxy configuration path run
  // against a throwaway endpoint builder; its typed failures already carry
  // self-descriptive, credential-free messages.
  return Effect.try({
    catch: () => undefined,
    try: () => request.probes.makeEndpointBuilder(),
  }).pipe(
    Effect.flatMap((builder) =>
      configureIrohProxy(
        builder,
        { _tag: "FromEnvironment" },
        request.environment
      ).pipe(
        Effect.as({
          detail:
            "An HTTP(S) proxy is configured and the installed iroh binding can use it.",
          name,
          status: "ok" as const,
        }),
        // The statuses mirror what run and pull actually do. A binding
        // without proxy support makes them fall back to a direct connection
        // ("warn": the udp-egress and relay-reachability checks cover that
        // path). A capable binding commits to the environment's proxy, so
        // proxy variables holding no usable URL block the dial ("fail").
        Effect.catchTags({
          BridgeProxyConfigurationError: (error) =>
            Effect.succeed({
              detail: error.message,
              name,
              status: "fail" as const,
            }),
          BridgeProxyUnsupportedError: (error) =>
            Effect.succeed({
              detail: `${error.message} run and pull fall back to a direct connection.`,
              name,
              status: "warn" as const,
            }),
        })
      )
    ),
    // A binding too broken to construct a builder cannot open any
    // connection; the failure stays check data instead of aborting the
    // report before it prints.
    Effect.catch(() =>
      Effect.succeed({
        detail:
          "The installed @number0/iroh binding could not construct an endpoint builder; run and pull cannot open a connection.",
        name,
        status: "fail" as const,
      })
    )
  );
};

// The proxy check runs first (it touches no network) because the relay
// check's proxy escape hatch only applies when the proxy is actually usable.
export const diagnoseIrohEnvironment = (
  request: IrohDiagnosisRequest
): Effect.Effect<readonly DiagnosisCheck[]> =>
  Effect.gen(function* () {
    const proxy = yield* proxyCheck({
      environment: request.environment,
      probes: request.probes,
    });
    const proxyUsable =
      hasProxyEnvironment(request.environment) && proxy.status === "ok";
    const networkChecks = yield* Effect.all(
      [
        dnsCheck(request),
        udpCheck(request.probes),
        relayCheck({
          probes: request.probes,
          proxyUsable,
          relayHosts: request.relayHosts,
        }),
      ],
      { concurrency: "unbounded" }
    );
    return [...networkChecks, proxy];
  });

const probeTimeoutMilliseconds = 4000;
const udpReplyTimeoutMilliseconds = 2000;

// A public anycast DNS resolver: answering the probe datagram proves UDP
// egress and a working return path without contacting any iroh host.
const udpProbeResolver = { address: "1.1.1.1", port: 53 };

// The datagram is a minimal DNS A query for example.com; its payload only
// matters insofar as the resolver sends something back.
const udpProbeQuery = () => {
  const encoder = new TextEncoder();
  const question = "example.com"
    .split(".")
    .flatMap((label) => [label.length, ...encoder.encode(label)]);
  const header = [0x13, 0x37, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  return Uint8Array.from([...header, ...question, 0, 0, 1, 0, 1]);
};

const settleWithin = <A>(run: Promise<A>, message: string) =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(message)),
      probeTimeoutMilliseconds
    );
    run.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

const sendHostUdpProbe = () =>
  new Promise<void>((resolve, reject) => {
    const socket = createSocket("udp4");
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const timer = setTimeout(
      () => finish(new Error("No UDP reply arrived within the probe window.")),
      udpReplyTimeoutMilliseconds
    );
    socket.once("message", () => finish());
    socket.once("error", (error) => finish(error));
    socket.send(
      udpProbeQuery(),
      udpProbeResolver.port,
      udpProbeResolver.address,
      (error) => {
        if (error !== null && error !== undefined) {
          finish(error);
        }
      }
    );
  });

const openHostTcp = (host: string, port: number) =>
  new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setTimeout(probeTimeoutMilliseconds);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("The TCP connection attempt timed out."));
    });
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });

const hostDiagnosticProbes: IrohDiagnosticProbes = {
  makeEndpointBuilder: () => Endpoint.builder(),
  openTcp: openHostTcp,
  resolveHost: (host) =>
    settleWithin(
      lookup(host).then(() => undefined),
      "The DNS lookup timed out."
    ),
  sendUdpProbe: sendHostUdpProbe,
};

const trailingDot = /\.$/;

// The relay hosts come from the same n0 production relay map the endpoint
// builders apply through applyN0(), never from a hardcoded list.
const defaultRelayHosts = (): readonly string[] =>
  RelayMode.defaultMode()
    .relayMap()
    .urls()
    .map((url) => new URL(url).hostname.replace(trailingDot, ""));

export const diagnoseHostIrohEnvironment = (
  environment: ProxyEnvironment
): Effect.Effect<readonly DiagnosisCheck[]> =>
  Effect.suspend(() => {
    // A binding that cannot yield its relay map must still produce a
    // report: the empty list becomes failing dns and relay checks instead
    // of a crashed effect that prints nothing.
    let relayHosts: readonly string[];
    try {
      relayHosts = defaultRelayHosts();
    } catch {
      relayHosts = [];
    }
    return diagnoseIrohEnvironment({
      environment,
      probes: hostDiagnosticProbes,
      relayHosts,
    });
  });
