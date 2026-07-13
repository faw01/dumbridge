import {
  type BiStream,
  type Connection,
  Endpoint,
  EndpointAddr,
  EndpointTicket,
  RelayMode,
} from "@number0/iroh";
import type { Duration } from "effect";
import { Effect, Option } from "effect";
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
  readonly reachability?: "direct-only" | "relay-only";
}

interface ResolvedOptions {
  readonly deadlines: BridgeDeadlines;
  readonly proxy: IrohProxyConfiguration;
  readonly reachability: "direct-only" | "relay-only";
}

const describeCause = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const closeConnection = (connection: Connection) =>
  Effect.sync(() => {
    connection.close(0n, closeReason);
  });

const closeEndpoint = (endpoint: Endpoint) =>
  Effect.promise(() => endpoint.close());

const interruptEndpoint = (endpoint: Endpoint) =>
  Effect.sync(() => endpoint.close()).pipe(Effect.asVoid);

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

const requireProxySupport = (
  proxy: IrohProxyConfiguration
): Effect.Effect<void, BridgeProxyUnsupportedError> => {
  if (proxy._tag === "Disabled") {
    return Effect.void;
  }

  const requested = proxy._tag === "FromEnvironment" ? "environment" : "url";

  return new BridgeProxyUnsupportedError({
    message:
      "The installed @number0/iroh binding does not expose proxy configuration.",
    requested,
  });
};

const makeSession = (
  connection: Connection,
  stream: BiStream,
  ioDeadline: Duration.Input
): BridgeSession => {
  const close = closeConnection(connection);
  const read = withDeadline(
    "read",
    ioDeadline,
    Effect.tryPromise({
      catch: (cause) =>
        new BridgeReadError({
          cause: describeCause(cause),
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
          catch: (cause) =>
            new BridgeWriteError({
              cause: describeCause(cause),
              message: "Could not write to the bridge session.",
            }),
          try: () => stream.send.writeAll(chunk),
        }),
        close
      ).pipe(Effect.flatMap(() => writeFrom(bytes, end)));
    });

  return {
    close,
    finish: withDeadline(
      "finish",
      ioDeadline,
      Effect.tryPromise({
        catch: (cause) =>
          new BridgeFinishError({
            cause: describeCause(cause),
            message: "Could not finish the bridge session.",
          }),
        try: () => stream.send.finish(),
      }),
      close
    ),
    read,
    write: (bytes) => writeFrom(bytes, 0),
  };
};

const acquireConnection = (connection: Connection) =>
  Effect.acquireRelease(Effect.succeed(connection), (activeConnection) =>
    closeConnection(activeConnection)
  );

const acceptSession = (
  endpoint: Endpoint,
  deadlines: BridgeDeadlines
): BridgeListener["accept"] => {
  const accept = Effect.gen(function* () {
    const incoming = yield* Effect.tryPromise({
      catch: (cause) =>
        new BridgeAcceptError({
          cause: describeCause(cause),
          message: "Could not accept an incoming bridge connection.",
        }),
      try: () => endpoint.acceptNext(),
    });

    if (incoming === null) {
      return yield* new BridgeListenerClosedError({
        message: "The bridge listener is closed.",
      });
    }

    const connection = yield* Effect.tryPromise({
      catch: (cause) =>
        new BridgeAcceptError({
          cause: describeCause(cause),
          message: "Could not establish an incoming bridge connection.",
        }),
      try: async () => (await incoming.accept()).connect(),
    });
    const activeConnection = yield* acquireConnection(connection);
    const stream = yield* Effect.tryPromise({
      catch: (cause) =>
        new BridgeAcceptError({
          cause: describeCause(cause),
          message: "Could not accept a bridge byte session.",
        }),
      try: () => activeConnection.acceptBi(),
    });

    return makeSession(activeConnection, stream, deadlines.io);
  });

  return withDeadline(
    "accept",
    deadlines.accept,
    accept,
    interruptEndpoint(endpoint)
  );
};

const listen = (options: ResolvedOptions): BridgeTransport["listen"] =>
  Effect.gen(function* () {
    yield* requireProxySupport(options.proxy);

    const endpoint = yield* Effect.acquireRelease(
      Effect.tryPromise({
        catch: (cause) =>
          new BridgeListenError({
            cause: describeCause(cause),
            message: "Could not open the bridge listener.",
          }),
        try: () => {
          const builder = Endpoint.builder();
          if (options.reachability === "direct-only") {
            builder.applyMinimal();
            builder.relayMode(RelayMode.disabled());
          } else {
            builder.applyN0();
          }
          builder.alpns([alpn]);
          return builder.bind();
        },
      }),
      (activeEndpoint) => closeEndpoint(activeEndpoint)
    );

    if (options.reachability === "relay-only") {
      yield* withDeadline(
        "listen",
        options.deadlines.listen,
        Effect.promise(() => endpoint.online()),
        interruptEndpoint(endpoint)
      );
    }

    const address = endpoint.addr();
    const locatorAddress = yield* Effect.try({
      catch: (cause) =>
        new BridgeListenError({
          cause: describeCause(cause),
          message: "Could not create the bridge locator.",
        }),
      try: () => {
        if (options.reachability === "direct-only") {
          return address;
        }

        const relayUrl = address.relayUrl();
        if (relayUrl === null) {
          throw new Error("Iroh did not provide a home relay.");
        }
        return new EndpointAddr(address.id(), relayUrl, []);
      },
    });
    const locator = BridgeLocator.fromString(
      EndpointTicket.fromAddr(locatorAddress).toString()
    );

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
    yield* requireProxySupport(options.proxy);

    const ticket = yield* Effect.try({
      catch: () =>
        new BridgeLocatorInvalidError({
          message: "The bridge transport locator is invalid.",
        }),
      try: () => EndpointTicket.fromString(locator.toString()),
    });
    const address = ticket.endpointAddr();

    if (options.reachability === "relay-only" && address.relayUrl() === null) {
      return yield* new BridgeLocatorInvalidError({
        message: "The bridge transport locator has no relay.",
      });
    }

    const endpoint = yield* Effect.acquireRelease(
      Effect.tryPromise({
        catch: (cause) =>
          new BridgeConnectError({
            cause: describeCause(cause),
            message: "Could not open the bridge client endpoint.",
          }),
        try: () => {
          const builder = Endpoint.builder();
          builder.applyMinimal();
          const relayUrl = address.relayUrl();
          builder.relayMode(
            relayUrl === null
              ? RelayMode.disabled()
              : RelayMode.customFromUrls([relayUrl])
          );
          return builder.bind();
        },
      }),
      (activeEndpoint) => closeEndpoint(activeEndpoint)
    );
    const connection = yield* withDeadline(
      "connect",
      options.deadlines.connect,
      Effect.tryPromise({
        catch: (cause) =>
          new BridgeConnectError({
            cause: describeCause(cause),
            message: "Could not connect to the bridge listener.",
          }),
        try: () => endpoint.connect(address, alpn),
      }),
      interruptEndpoint(endpoint)
    );
    const activeConnection = yield* acquireConnection(connection);
    const stream = yield* withDeadline(
      "connect",
      options.deadlines.connect,
      Effect.tryPromise({
        catch: (cause) =>
          new BridgeConnectError({
            cause: describeCause(cause),
            message: "Could not open a bridge byte session.",
          }),
        try: () => activeConnection.openBi(),
      }),
      closeConnection(activeConnection)
    );

    return makeSession(activeConnection, stream, options.deadlines.io);
  });

const resolveOptions = (
  options: IrohTransportOptions | undefined
): ResolvedOptions => ({
  deadlines: {
    ...defaultDeadlines,
    ...options?.deadlines,
  },
  proxy: options?.proxy ?? { _tag: "Disabled" },
  reachability: options?.reachability ?? "relay-only",
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
