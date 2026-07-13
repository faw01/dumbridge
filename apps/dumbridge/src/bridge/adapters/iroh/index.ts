import {
  type BiStream,
  type Connection,
  Endpoint,
  EndpointAddr,
  EndpointTicket,
  type Incoming,
  RelayMode,
} from "@number0/iroh";
import type { Duration } from "effect";
import { Effect, Option, Semaphore } from "effect";
import {
  BridgeAcceptError,
  BridgeConnectError,
  BridgeDeadlineExceededError,
  type BridgeDeadlines,
  BridgeFinishError,
  BridgeListenError,
  type BridgeListener,
  BridgeListenerClosedError,
  BridgeLocator,
  BridgeLocatorInvalidError,
  BridgeProxyConfigurationError,
  BridgeProxyUnsupportedError,
  BridgeReadError,
  type BridgeSession,
  type BridgeTransport,
  BridgeWriteError,
} from "../../transport";

const alpn = Array.from(new TextEncoder().encode("dumbridge/1"));
const closeReason = Array.from(
  new TextEncoder().encode("dumbridge session closed")
);
const chunkSize = 64 * 1024;
const defaultDeadlines: BridgeDeadlines = {
  accept: "30 seconds",
  connect: "15 seconds",
  io: "30 seconds",
  listen: "15 seconds",
};

export type IrohProxyConfiguration =
  | { readonly _tag: "Disabled" }
  | { readonly _tag: "FromEnvironment" }
  | { readonly _tag: "Url"; readonly url: string };

export interface IrohTransportOptions {
  readonly deadlines?: Partial<BridgeDeadlines>;
  readonly proxy?: IrohProxyConfiguration;
  readonly reachability?: IrohReachability;
}

/**
 * Controls the routes configured and encoded in the initial locator.
 * `direct-only` disables relays. `relay-only` seeds only a relay route, though
 * Iroh may migrate an established connection to a discovered direct path.
 * `direct-or-relay` advertises both and is the default.
 */
export type IrohReachability = "direct-only" | "relay-only" | "direct-or-relay";

interface ResolvedOptions {
  readonly deadlines: BridgeDeadlines;
  readonly proxy: IrohProxyConfiguration;
  readonly reachability: IrohReachability;
}

interface ProxyAwareEndpointBuilder {
  readonly proxyFromEnv?: () => void;
  readonly proxyUrl?: (url: string) => void;
}

const closeConnectionImmediately = (connection: Connection) => {
  try {
    connection.close(0n, closeReason);
  } catch {
    // The connection is already closed or no longer usable.
  }
};

const closeConnection = (connection: Connection) =>
  Effect.sync(() => closeConnectionImmediately(connection));

const closeEndpoint = (endpoint: Endpoint) =>
  Effect.tryPromise({
    catch: () => undefined,
    try: () => endpoint.close(),
  }).pipe(Effect.catch(() => Effect.void));

const refuseIncoming = (incoming: Incoming) =>
  Effect.tryPromise({
    catch: () => undefined,
    try: () => incoming.refuse(),
  }).pipe(Effect.catch(() => Effect.void));

const withDeadline = <A, E, R>(
  operation: "accept" | "connect" | "finish" | "listen" | "read" | "write",
  duration: Duration.Input,
  effect: Effect.Effect<A, E, R>,
  onTimeout: Effect.Effect<void>
): Effect.Effect<A, E | BridgeDeadlineExceededError, R> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () =>
        onTimeout.pipe(
          Effect.flatMap(
            () =>
              new BridgeDeadlineExceededError({
                message: `${operation} deadline exceeded`,
                operation,
              })
          )
        ),
    })
  );

export const configureIrohProxy = (
  builder: object,
  proxy: IrohProxyConfiguration
): Effect.Effect<
  void,
  BridgeProxyConfigurationError | BridgeProxyUnsupportedError
> => {
  if (proxy._tag === "Disabled") {
    return Effect.void;
  }

  const proxyAwareBuilder = builder as ProxyAwareEndpointBuilder;
  const requested = proxy._tag === "FromEnvironment" ? "environment" : "url";
  let configure: (() => void) | undefined;
  if (proxy._tag === "FromEnvironment") {
    configure = proxyAwareBuilder.proxyFromEnv;
  } else if (proxyAwareBuilder.proxyUrl !== undefined) {
    configure = () => proxyAwareBuilder.proxyUrl?.(proxy.url);
  }

  if (configure === undefined) {
    return new BridgeProxyUnsupportedError({
      message:
        "The installed @number0/iroh binding does not expose proxy configuration.",
      requested,
    });
  }

  return Effect.try({
    catch: () =>
      new BridgeProxyConfigurationError({
        message: "Could not configure the Iroh proxy.",
        requested,
      }),
    try: () => configure.call(proxyAwareBuilder),
  });
};

export const normalizeIrohAddress = (
  address: EndpointAddr,
  reachability: IrohReachability
): Effect.Effect<EndpointAddr, BridgeLocatorInvalidError> => {
  const directAddresses = address.directAddresses();
  const relayUrl = address.relayUrl();

  if (reachability === "direct-only" && directAddresses.length === 0) {
    return new BridgeLocatorInvalidError({
      message: "The bridge transport locator has no direct address.",
    });
  }

  if (reachability === "relay-only" && relayUrl === null) {
    return new BridgeLocatorInvalidError({
      message: "The bridge transport locator has no relay.",
    });
  }

  if (
    reachability === "direct-or-relay" &&
    relayUrl === null &&
    directAddresses.length === 0
  ) {
    return new BridgeLocatorInvalidError({
      message: "The bridge transport locator has no reachable address.",
    });
  }

  return Effect.try({
    catch: () =>
      new BridgeLocatorInvalidError({
        message: "The bridge transport locator is invalid.",
      }),
    try: () => {
      if (reachability === "direct-only") {
        return new EndpointAddr(address.id(), null, directAddresses);
      }
      if (reachability === "relay-only") {
        return new EndpointAddr(address.id(), relayUrl, []);
      }
      return new EndpointAddr(address.id(), relayUrl, directAddresses);
    },
  });
};

const makeSession = (
  connection: Connection,
  stream: BiStream,
  ioDeadline: Duration.Input
): Effect.Effect<BridgeSession> =>
  Effect.gen(function* () {
    const writeLock = yield* Semaphore.make(1);
    const close = closeConnection(connection);
    const read = withDeadline(
      "read",
      ioDeadline,
      Effect.tryPromise({
        catch: () =>
          new BridgeReadError({
            message: "Could not read from the bridge session.",
          }),
        try: () => stream.recv.read(chunkSize),
      }),
      close
    ).pipe(
      Effect.map((bytes) =>
        bytes.length === 0
          ? Option.none<Uint8Array>()
          : Option.some(Uint8Array.from(bytes))
      )
    );

    const writeFrom = (
      bytes: Uint8Array,
      offset: number
    ): Effect.Effect<void, BridgeWriteError | BridgeDeadlineExceededError> =>
      Effect.suspend(() => {
        if (offset >= bytes.byteLength) {
          return Effect.void;
        }

        const end = Math.min(offset + chunkSize, bytes.byteLength);
        const chunk = Array.from(bytes.subarray(offset, end));

        return withDeadline(
          "write",
          ioDeadline,
          Effect.tryPromise({
            catch: () =>
              new BridgeWriteError({
                message: "Could not write to the bridge session.",
              }),
            try: () => stream.send.writeAll(chunk),
          }),
          close
        ).pipe(Effect.flatMap(() => writeFrom(bytes, end)));
      });

    return {
      close,
      finish: writeLock.withPermits(1)(
        withDeadline(
          "finish",
          ioDeadline,
          Effect.tryPromise({
            catch: () =>
              new BridgeFinishError({
                message: "Could not finish the bridge session.",
              }),
            try: () => stream.send.finish(),
          }),
          close
        )
      ),
      read,
      write: (bytes) => writeLock.withPermits(1)(writeFrom(bytes, 0)),
    } satisfies BridgeSession;
  });

const acquireConnection = (connection: Connection) =>
  Effect.acquireRelease(Effect.succeed(connection), (activeConnection) =>
    closeConnection(activeConnection)
  );

const acceptSession = (
  endpoint: Endpoint,
  deadlines: BridgeDeadlines
): BridgeListener["accept"] =>
  Effect.gen(function* () {
    const incoming = yield* Effect.tryPromise({
      catch: () =>
        new BridgeAcceptError({
          message: "Could not accept an incoming bridge connection.",
        }),
      try: () => endpoint.acceptNext(),
    });

    if (incoming === null) {
      return yield* new BridgeListenerClosedError({
        message: "The bridge listener is closed.",
      });
    }

    let handshakeExpired = false;
    const abandonHandshake = Effect.sync(() => {
      handshakeExpired = true;
    }).pipe(Effect.flatMap(() => refuseIncoming(incoming)));
    const connection = yield* withDeadline(
      "accept",
      deadlines.accept,
      Effect.tryPromise({
        catch: () =>
          new BridgeAcceptError({
            message: "Could not establish an incoming bridge connection.",
          }),
        try: async () => {
          const accepted = await incoming.accept();
          const established = await accepted.connect();
          if (handshakeExpired) {
            closeConnectionImmediately(established);
            throw new Error("The incoming bridge handshake was abandoned.");
          }
          return established;
        },
      }),
      abandonHandshake
    ).pipe(Effect.tapError(() => refuseIncoming(incoming)));
    const activeConnection = yield* acquireConnection(connection);
    const stream = yield* withDeadline(
      "accept",
      deadlines.accept,
      Effect.tryPromise({
        catch: () =>
          new BridgeAcceptError({
            message: "Could not accept a bridge byte session.",
          }),
        try: () => activeConnection.acceptBi(),
      }),
      closeConnection(activeConnection)
    );

    return yield* makeSession(activeConnection, stream, deadlines.io);
  });

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

    const endpoint = yield* Effect.acquireRelease(
      Effect.tryPromise({
        catch: () =>
          new BridgeListenError({
            message: "Could not open the bridge listener.",
          }),
        try: () => builder.bind(),
      }),
      (activeEndpoint) => closeEndpoint(activeEndpoint)
    );

    if (options.reachability !== "direct-only") {
      yield* withDeadline(
        "listen",
        options.deadlines.listen,
        Effect.tryPromise({
          catch: () =>
            new BridgeListenError({
              message: "Could not bring the bridge listener online.",
            }),
          try: () => endpoint.online(),
        }),
        closeEndpoint(endpoint)
      );
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
      options.reachability
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

    const endpoint = yield* Effect.acquireRelease(
      Effect.tryPromise({
        catch: () =>
          new BridgeConnectError({
            message: "Could not open the bridge client endpoint.",
          }),
        try: () => builder.bind(),
      }),
      (activeEndpoint) => closeEndpoint(activeEndpoint)
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
