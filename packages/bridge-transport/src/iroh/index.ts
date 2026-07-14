import { Endpoint, EndpointTicket, RelayMode } from "@number0/iroh";
import { Effect } from "effect";
import {
  BridgeConnectError,
  type BridgeDeadlines,
  BridgeListenError,
  BridgeLocator,
  BridgeLocatorInvalidError,
  type BridgeTransport,
} from "../index";
import {
  acquireEndpoint,
  closeConnection,
  closeEndpoint,
  type IrohReachability,
  normalizeIrohAddress,
  withDeadline,
} from "./endpoint";
import { configureIrohProxy, type IrohProxyConfiguration } from "./proxy";
import { acceptSession, acquireConnection, makeSession } from "./session";

const alpn = Array.from(new TextEncoder().encode("dumbridge/1"));
const defaultDeadlines: BridgeDeadlines = {
  accept: "30 seconds",
  connect: "15 seconds",
  io: "3 hours",
  listen: "15 seconds",
};

export type { IrohReachability } from "./endpoint";
export { normalizeIrohAddress } from "./endpoint";
export type { IrohProxyConfiguration } from "./proxy";
export { configureIrohProxy } from "./proxy";

export interface IrohTransportOptions {
  readonly deadlines?: Partial<BridgeDeadlines>;
  readonly proxy?: IrohProxyConfiguration;
  readonly reachability?: IrohReachability;
}

interface ResolvedOptions {
  readonly deadlines: BridgeDeadlines;
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

    const builder = yield* Effect.try({
      catch: () =>
        new BridgeConnectError({
          message: "Could not configure the bridge client endpoint.",
        }),
      try: () => {
        const configured = Endpoint.builder();
        configured.applyMinimal();
        const relayUrl = normalizedAddress.relayUrl();
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
    const connection = yield* withDeadline(
      "connect",
      options.deadlines.connect,
      Effect.tryPromise({
        catch: () =>
          new BridgeConnectError({
            message: "Could not connect to the bridge listener.",
          }),
        try: () => endpoint.connect(normalizedAddress, alpn),
      }),
      closeEndpoint(endpoint)
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

    return yield* makeSession(activeConnection, stream, options.deadlines.io);
  });

const resolveOptions = (
  options: IrohTransportOptions | undefined
): ResolvedOptions => ({
  deadlines: {
    ...defaultDeadlines,
    ...options?.deadlines,
  },
  proxy: options?.proxy ?? { _tag: "Disabled" },
  reachability: options?.reachability ?? "direct-or-relay",
});

export const makeIrohTransport = (
  options?: IrohTransportOptions
): BridgeTransport => {
  const resolved = resolveOptions(options);

  return {
    connect: (locator) => connect(locator, resolved),
    listen: listen(resolved),
  };
};
