import {
  type BiStream,
  type Connection,
  Endpoint,
  EndpointAddr,
  EndpointTicket,
  type Incoming,
  RelayMode,
} from "@number0/iroh";
import { Duration, Effect, Option, Semaphore } from "effect";
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
  io: "3 hours",
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
 * `direct-or-relay` waits up to the listener deadline for a home relay, then
 * degrades to a proven direct route when relay readiness fails. It is the
 * default.
 */
export type IrohReachability = "direct-only" | "relay-only" | "direct-or-relay";

interface ResolvedOptions {
  readonly deadlines: BridgeDeadlines;
  readonly proxy: IrohProxyConfiguration;
  readonly reachability: IrohReachability;
}

interface ProxyAwareEndpointBuilder {
  readonly proxyUrl?: (url: string) => void;
}

interface BindableEndpointBuilder {
  readonly bind: () => Promise<Endpoint>;
}

type ProxyEnvironment = Readonly<Record<string, string | undefined>>;

const proxyEnvironmentKeys = [
  // Preserve Iroh's native precedence before the generic HTTP(S) fallbacks.
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

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

const closeEndpointImmediately = (endpoint: Endpoint) => {
  try {
    endpoint.close().catch(() => undefined);
  } catch {
    // The endpoint is already closed or no longer usable.
  }
};

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

const proxyUrlFromEnvironment = (
  environment: ProxyEnvironment
): Effect.Effect<string, BridgeProxyConfigurationError> => {
  const isCgi = environment.REQUEST_METHOD !== undefined;

  for (const key of proxyEnvironmentKeys) {
    if (key === "HTTP_PROXY" && isCgi) {
      continue;
    }

    const candidate = environment[key];
    if (candidate === undefined) {
      continue;
    }

    try {
      const url = new URL(candidate);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.hostname.length > 0
      ) {
        return Effect.succeed(url.toString());
      }
    } catch {
      // Try the next conventional proxy environment variable.
    }
  }

  return new BridgeProxyConfigurationError({
    message:
      "No valid HTTP(S) proxy was found in the proxy environment variables.",
    requested: "environment",
  });
};

export const configureIrohProxy = (
  builder: object,
  proxy: IrohProxyConfiguration,
  environment: ProxyEnvironment = process.env
): Effect.Effect<
  void,
  BridgeProxyConfigurationError | BridgeProxyUnsupportedError
> => {
  if (proxy._tag === "Disabled") {
    return Effect.void;
  }

  const proxyAwareBuilder = builder as ProxyAwareEndpointBuilder;
  const requested = proxy._tag === "FromEnvironment" ? "environment" : "url";
  if (proxyAwareBuilder.proxyUrl === undefined) {
    return new BridgeProxyUnsupportedError({
      message:
        "The installed @number0/iroh binding does not expose proxy configuration.",
      requested,
    });
  }

  const proxyUrl =
    proxy._tag === "FromEnvironment"
      ? proxyUrlFromEnvironment(environment)
      : Effect.succeed(proxy.url);

  return proxyUrl.pipe(
    Effect.flatMap((url) =>
      Effect.try({
        catch: () =>
          new BridgeProxyConfigurationError({
            message: "Could not configure the Iroh proxy.",
            requested,
          }),
        try: () => proxyAwareBuilder.proxyUrl?.(url),
      })
    )
  );
};

const bindEndpoint = <E>(
  builder: BindableEndpointBuilder,
  operation: "connect" | "listen",
  deadline: Duration.Input,
  onFailure: () => E
): Effect.Effect<Endpoint, E | BridgeDeadlineExceededError> =>
  Effect.tryPromise({
    catch: (error) =>
      error instanceof BridgeDeadlineExceededError ? error : onFailure(),
    try: (signal) =>
      new Promise<Endpoint>((resolve, reject) => {
        let abandoned = false;
        let boundEndpoint: Endpoint | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const milliseconds = Duration.toMillis(deadline);
        const binding = builder.bind();

        const clearDeadline = () => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
        };
        const closeBoundEndpoint = () => {
          const endpoint = boundEndpoint;
          boundEndpoint = undefined;
          if (endpoint !== undefined) {
            closeEndpointImmediately(endpoint);
          }
        };
        const abandon = () => {
          abandoned = true;
          clearDeadline();
          closeBoundEndpoint();
        };
        signal.addEventListener("abort", abandon, { once: true });

        if (Number.isFinite(milliseconds)) {
          timer = setTimeout(
            () => {
              abandoned = true;
              timer = undefined;
              signal.removeEventListener("abort", abandon);
              reject(
                new BridgeDeadlineExceededError({
                  message: `${operation} deadline exceeded`,
                  operation,
                })
              );
            },
            Math.max(0, milliseconds)
          );
        }

        binding.then(
          (endpoint) => {
            boundEndpoint = endpoint;
            if (abandoned || signal.aborted) {
              abandon();
              return;
            }
            clearDeadline();
            // Retain ownership until Effect's queued continuation can receive it.
            resolve(endpoint);
            queueMicrotask(() => {
              boundEndpoint = undefined;
              signal.removeEventListener("abort", abandon);
            });
          },
          (error: unknown) => {
            if (abandoned || signal.aborted) {
              return;
            }
            clearDeadline();
            signal.removeEventListener("abort", abandon);
            reject(error);
          }
        );
      }),
  });

const acquireEndpoint = <E>(
  builder: BindableEndpointBuilder,
  operation: "connect" | "listen",
  deadline: Duration.Input,
  onFailure: () => E
) =>
  Effect.acquireRelease(
    bindEndpoint(builder, operation, deadline, onFailure),
    (endpoint) => closeEndpoint(endpoint),
    { interruptible: true }
  );

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
      Effect.tapError(() => close),
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
        ).pipe(
          Effect.tapError(() => close),
          Effect.flatMap(() => writeFrom(bytes, end))
        );
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
            try: async () => {
              await stream.send.finish();
              const stopped = await stream.send.stopped();
              if (stopped !== null) {
                throw new Error("The peer stopped the bridge stream.");
              }
            },
          }),
          close
        ).pipe(Effect.tapError(() => close))
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
