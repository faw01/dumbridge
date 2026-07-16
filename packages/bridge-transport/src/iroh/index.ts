import { Endpoint, EndpointTicket, RelayMode } from "@number0/iroh";
import { Effect } from "effect";
import {
  BridgeConnectError,
  type BridgeDeadlines,
  BridgeDialError,
  type BridgeDialReason,
  BridgeDirectConnectError,
  BridgeListenError,
  BridgeLocator,
  BridgeLocatorInvalidError,
  type BridgeTransport,
} from "../index";
import { diagnoseHostIrohEnvironment } from "./diagnose";
import {
  acquireEndpoint,
  closeConnection,
  closeEndpoint,
  type IrohReachability,
  normalizeIrohAddress,
  withDeadline,
} from "./endpoint";
import type { ProxyEnvironment } from "./proxy";
import { configureIrohProxy, type IrohProxyConfiguration } from "./proxy";
import { acceptSession, acquireConnection, makeSession } from "./session";

const alpn = Array.from(new TextEncoder().encode("dumbridge/1"));
const defaultDeadlines: BridgeDeadlines = {
  accept: "30 seconds",
  connect: "15 seconds",
  io: "3 hours",
  listen: "15 seconds",
};

export type { IrohDiagnosticProbes } from "./diagnose";
export { diagnoseIrohEnvironment } from "./diagnose";
export type { IrohReachability } from "./endpoint";
export { normalizeIrohAddress } from "./endpoint";
export type { IrohProxyConfiguration } from "./proxy";
export { configureIrohProxy, irohBindingSupportsProxy } from "./proxy";

// Iroh keeps a trailing dot on relay hostnames; the reported host matches
// what a user would put in an egress allowlist.
const trailingDot = /\.$/;

const relayHostForDisplay = (relayUrl: string) => {
  try {
    return new URL(relayUrl).hostname.replace(trailingDot, "");
  } catch {
    return relayUrl;
  }
};

const dialFailureMessages: Record<
  BridgeDialReason,
  (relayHost: string) => string
> = {
  "peer-offline": () =>
    "The bridge did not answer: the relay is reachable, so dumbridge serve has likely stopped or the local machine is offline.",
  "relay-unreachable": (relayHost) =>
    `The relay at ${relayHost} could not be reached: this network may block it, and no direct path to the bridge was found. Allow HTTPS to ${relayHost} and retry.`,
};

// The adapter is the only place that knows why a dial failed: it watched the
// relay link while the dial ran. The snapshot classifies the failure into an
// iroh-agnostic reason; ambiguity stays honest — a blocked relay hides
// whether the peer was also offline, so the reason names only what was
// observed.
export const classifyDialFailure = (observed: {
  readonly cause: unknown;
  readonly relayConnected: boolean;
  readonly relayUrl: string;
}): BridgeDialError => {
  const reason = observed.relayConnected ? "peer-offline" : "relay-unreachable";
  const relayHost = relayHostForDisplay(observed.relayUrl);
  return new BridgeDialError({
    cause: observed.cause,
    message: dialFailureMessages[reason](relayHost),
    reason,
    relayHost,
  });
};

export interface IrohTransportOptions {
  readonly deadlines?: Partial<BridgeDeadlines>;
  // The proxy environment the diagnosis inspects, threaded in from the CLI
  // shell; omitted means no proxy variables are visible to diagnose.
  readonly environment?: ProxyEnvironment;
  readonly proxy?: IrohProxyConfiguration;
  readonly reachability?: IrohReachability;
}

interface ResolvedOptions {
  readonly deadlines: BridgeDeadlines;
  readonly environment: ProxyEnvironment;
  readonly proxy: IrohProxyConfiguration;
  readonly reachability: IrohReachability;
}

const listen = (options: ResolvedOptions): BridgeTransport["listen"] =>
  Effect.gen(function* () {
    const builder = yield* Effect.try({
      catch: () =>
        new BridgeListenError({
          message: "Could not configure the bridge listener.",
        }),
      try: () => {
        const configured = Endpoint.builder();
        if (options.reachability === "direct-only") {
          configured.applyMinimal();
          configured.relayMode(RelayMode.disabled());
        } else {
          configured.applyN0();
        }
        configured.alpns([alpn]);
        return configured;
      },
    });
    yield* configureIrohProxy(builder, options.proxy);

    const endpoint = yield* acquireEndpoint(
      builder,
      "listen",
      options.deadlines.listen,
      () =>
        new BridgeListenError({
          message: "Could not open the bridge listener.",
        })
    );

    const homeRelayReady = Effect.tryPromise({
      catch: () =>
        new BridgeListenError({
          message: "Could not bring the bridge listener online.",
        }),
      try: () => endpoint.online(),
    });
    let locatorReachability = options.reachability;

    if (options.reachability === "relay-only") {
      yield* withDeadline(
        "listen",
        options.deadlines.listen,
        homeRelayReady,
        closeEndpoint(endpoint)
      );
    } else if (options.reachability === "direct-or-relay") {
      const relayReady = yield* withDeadline(
        "listen",
        options.deadlines.listen,
        homeRelayReady,
        Effect.void
      ).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      );
      if (!relayReady) {
        locatorReachability = "direct-only";
      }
    }

    const address = yield* Effect.try({
      catch: () =>
        new BridgeListenError({
          message: "Could not create the bridge locator.",
        }),
      try: () => endpoint.addr(),
    });
    const locatorAddress = yield* normalizeIrohAddress(
      address,
      locatorReachability
    ).pipe(
      Effect.mapError(
        () =>
          new BridgeListenError({
            message: "Could not create the bridge locator.",
          })
      )
    );
    const locator = yield* Effect.try({
      catch: () =>
        new BridgeListenError({
          message: "Could not encode the bridge locator.",
        }),
      try: () =>
        BridgeLocator.fromString(
          EndpointTicket.fromAddr(locatorAddress).toString()
        ),
    });

    return {
      accept: acceptSession(endpoint, options.deadlines),
      locator,
    };
  });

// addr() includes the home relay only once its link is actually up, so the
// snapshot distinguishes a blocked relay from a silent peer, and it survives
// the endpoint close that a timed-out dial performs first. It is a plain
// native read: endpoint.online() would answer the same question but its
// pending promise keeps the runtime's event loop alive after the dial, and a
// watcher callback needs the same teardown care. A native read failure is
// reported as "the link never came up".
const relayLinkObserved = (endpoint: Endpoint) => {
  try {
    return endpoint.addr().relayUrl() !== null;
  } catch {
    return false;
  }
};

const connect = (
  locator: BridgeLocator,
  options: ResolvedOptions
): ReturnType<BridgeTransport["connect"]> =>
  Effect.gen(function* () {
    const address = yield* Effect.try({
      catch: () =>
        new BridgeLocatorInvalidError({
          message: "The bridge transport locator is invalid.",
        }),
      try: () => EndpointTicket.fromString(locator.toString()).endpointAddr(),
    });
    const normalizedAddress = yield* normalizeIrohAddress(
      address,
      options.reachability
    );

    const relayUrl = normalizedAddress.relayUrl();
    const relayHost = relayUrl === null ? null : relayHostForDisplay(relayUrl);
    const builder = yield* Effect.try({
      catch: () =>
        new BridgeConnectError({
          message: "Could not configure the bridge client endpoint.",
        }),
      try: () => {
        const configured = Endpoint.builder();
        configured.applyMinimal();
        configured.relayMode(
          relayUrl === null
            ? RelayMode.disabled()
            : RelayMode.customFromUrls([relayUrl])
        );
        return configured;
      },
    });
    yield* configureIrohProxy(builder, options.proxy);

    const endpoint = yield* acquireEndpoint(
      builder,
      "connect",
      options.deadlines.connect,
      () =>
        new BridgeConnectError({
          message: "Could not open the bridge client endpoint.",
        })
    );
    // The locator's addresses are the peer's published reachability hints,
    // not secrets; the opaque locator ticket itself is never logged.
    yield* Effect.logDebug("bridge dial: attempting", {
      directAddresses: normalizedAddress.directAddresses(),
      relay: relayHost ?? "none",
    });
    const connection = yield* withDeadline(
      "connect",
      options.deadlines.connect,
      Effect.tryPromise({
        catch: (cause) =>
          new BridgeConnectError({
            cause,
            message: "Could not connect to the bridge listener.",
          }),
        try: () => endpoint.connect(normalizedAddress, alpn),
      }),
      closeEndpoint(endpoint)
    ).pipe(
      Effect.mapError((error) => {
        if (relayUrl === null) {
          // With RelayMode.disabled there is no fallback: a dial that
          // cannot holepunch fails or times out instead of degrading to a
          // relay, and both shapes surface as the branded failure so
          // callers do not retry.
          return new BridgeDirectConnectError({
            message:
              "No viable network path to the bridge: the direct connection failed (this network may block UDP) and the bridge locator allows no relay fallback.",
          });
        }
        // The snapshot is taken at failure time: a dial that fails with the
        // relay link up points at the peer, one that fails with the link
        // down points at the relay path.
        return classifyDialFailure({
          cause: error,
          relayConnected: relayLinkObserved(endpoint),
          relayUrl,
        });
      }),
      Effect.tapError((error) =>
        Effect.logDebug("bridge dial: failed", {
          reason:
            error instanceof BridgeDialError ? error.reason : "no-direct-path",
          relay: relayHost ?? "none",
        })
      )
    );
    const activeConnection = yield* acquireConnection(connection);
    const stream = yield* withDeadline(
      "connect",
      options.deadlines.connect,
      Effect.tryPromise({
        catch: () =>
          new BridgeConnectError({
            message: "Could not open a bridge byte session.",
          }),
        try: () => activeConnection.openBi(),
      }),
      closeConnection(activeConnection)
    );

    const session = yield* makeSession(
      activeConnection,
      stream,
      options.deadlines.io
    );
    yield* Effect.logDebug("bridge dial: connected", {
      path: session.connectionPath,
      relay: relayHost ?? "none",
    });
    return session;
  });

const resolveOptions = (
  options: IrohTransportOptions | undefined
): ResolvedOptions => ({
  deadlines: {
    ...defaultDeadlines,
    ...options?.deadlines,
  },
  environment: options?.environment ?? {},
  proxy: options?.proxy ?? { _tag: "Disabled" },
  reachability: options?.reachability ?? "direct-or-relay",
});

export const makeIrohTransport = (
  options?: IrohTransportOptions
): BridgeTransport => {
  const resolved = resolveOptions(options);

  return {
    connect: (locator) => connect(locator, resolved),
    diagnose: diagnoseHostIrohEnvironment(resolved.environment),
    listen: listen(resolved),
  };
};
