import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { Endpoint, RelayMode } from "@number0/iroh";
import { Effect } from "effect";
import type { DiagnosisCheck } from "../index";
import {
  caTrustSourceFromEnvironment,
  caTrustUnsupportedMessage,
  configureIrohCaTrust,
  irohBindingSupportsCaTrust,
} from "./ca";
import {
  configureIrohProxy,
  hasProxyEnvironment,
  type ProxyEnvironment,
} from "./proxy";

export interface IrohDiagnosticProbes {
  readonly makeEndpointBuilder: () => object;
  readonly openTcp: (host: string, port: number) => Promise<void>;
  readonly readTextFile: (path: string) => Promise<string>;
  readonly resolveHost: (host: string) => Promise<void>;
  readonly sendUdpProbe: () => Promise<void>;
}

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

const emptyRelayHostsDetail =
  "No iroh relay hosts could be read from the installed binding's default relay configuration.";

const dnsCheck = (request: {
  readonly probes: IrohDiagnosticProbes;
  readonly proxyUsable: boolean;
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
        if (request.proxyUsable) {
          return {
            detail: `Could not resolve any of the ${total} iroh relay hosts locally; with an HTTP(S) proxy configured, the proxy resolves relay hostnames itself, a path this probe does not test.`,
            name,
            status: "warn" as const,
          };
        }
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

const withThrowawayBuilder = (
  name: string,
  probes: IrohDiagnosticProbes,
  check: (builder: object) => Effect.Effect<DiagnosisCheck>
): Effect.Effect<DiagnosisCheck> =>
  Effect.try({
    catch: () => undefined,
    try: () => probes.makeEndpointBuilder(),
  }).pipe(
    Effect.flatMap(check),
    Effect.catch(() =>
      Effect.succeed({
        detail:
          "The installed @number0/iroh binding could not construct an endpoint builder; run and pull cannot open a connection.",
        name,
        status: "fail" as const,
      })
    )
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
  return withThrowawayBuilder(name, request.probes, (builder) =>
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
  );
};

const caTrustCheck = (request: {
  readonly environment: ProxyEnvironment;
  readonly probes: IrohDiagnosticProbes;
  readonly proxyUsable: boolean;
}): Effect.Effect<DiagnosisCheck> => {
  const name = "ca-trust";
  if (!request.proxyUsable) {
    return Effect.succeed({
      detail:
        "Extra CA trust applies only when run and pull tunnel through a usable HTTP(S) proxy; this environment does not.",
      name,
      status: "ok" as const,
    });
  }
  const source = caTrustSourceFromEnvironment(request.environment);
  if (source === undefined) {
    return Effect.succeed({
      detail: "No extra CA trust source is set in the environment.",
      name,
      status: "ok" as const,
    });
  }
  return withThrowawayBuilder(name, request.probes, (builder) => {
    if (!irohBindingSupportsCaTrust(builder)) {
      return Effect.succeed({
        detail: `${caTrustUnsupportedMessage} run and pull continue without the extra CA roots.`,
        name,
        status: "warn" as const,
      });
    }
    return Effect.tryPromise({
      catch: () => undefined,
      try: () => request.probes.readTextFile(source.path),
    }).pipe(
      Effect.flatMap((pem) =>
        configureIrohCaTrust(builder, { _tag: "ExtraRootsPem", pem }).pipe(
          Effect.as({
            detail: `An extra CA certificate from ${source.name} is configured and the installed iroh binding trusts it.`,
            name,
            status: "ok" as const,
          }),
          Effect.catchTags({
            BridgeCaTrustConfigurationError: (error) =>
              Effect.succeed({
                detail: error.message,
                name,
                status: "fail" as const,
              }),
            BridgeCaTrustUnsupportedError: (error) =>
              Effect.succeed({
                detail: `${error.message} run and pull continue without the extra CA roots.`,
                name,
                status: "warn" as const,
              }),
          })
        )
      ),
      Effect.catch(() =>
        Effect.succeed({
          detail: `${source.name} names an extra CA certificate file that could not be read; run and pull continue without it.`,
          name,
          status: "warn" as const,
        })
      )
    );
  });
};

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
    const caTrust = yield* caTrustCheck({
      environment: request.environment,
      probes: request.probes,
      proxyUsable,
    });
    const networkChecks = yield* Effect.all(
      [
        dnsCheck({
          probes: request.probes,
          proxyUsable,
          relayHosts: request.relayHosts,
        }),
        udpCheck(request.probes),
        relayCheck({
          probes: request.probes,
          proxyUsable,
          relayHosts: request.relayHosts,
        }),
      ],
      { concurrency: "unbounded" }
    );
    return [...networkChecks, proxy, caTrust];
  });

const probeTimeoutMilliseconds = 4000;
const udpReplyTimeoutMilliseconds = 2000;

const udpProbeResolver = { address: "1.1.1.1", port: 53 };

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
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const timer = setTimeout(
      () => finish(new Error("The TCP connection attempt timed out.")),
      probeTimeoutMilliseconds
    );
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });

const hostDiagnosticProbes: IrohDiagnosticProbes = {
  makeEndpointBuilder: () => Endpoint.builder(),
  openTcp: openHostTcp,
  readTextFile: (path) => readFile(path, "utf8"),
  resolveHost: (host) =>
    settleWithin(
      lookup(host).then(() => undefined),
      "The DNS lookup timed out."
    ),
  sendUdpProbe: sendHostUdpProbe,
};

const trailingDot = /\.$/;

const defaultRelayHosts = (): readonly string[] =>
  RelayMode.defaultMode()
    .relayMap()
    .urls()
    .map((url) => new URL(url).hostname.replace(trailingDot, ""));

export const diagnoseHostIrohEnvironment = (
  environment: ProxyEnvironment
): Effect.Effect<readonly DiagnosisCheck[]> =>
  Effect.suspend(() => {
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
