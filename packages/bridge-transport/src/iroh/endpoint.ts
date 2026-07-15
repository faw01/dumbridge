import type {
  Connection,
  Endpoint,
  EndpointAddr,
  Incoming,
} from "@number0/iroh";
import { EndpointAddr as EndpointAddrClass } from "@number0/iroh";
import { Duration, Effect } from "effect";
import {
  BridgeDeadlineExceededError,
  BridgeLocatorInvalidError,
} from "../index";

export const closeReason = Array.from(
  new TextEncoder().encode("dumbridge session closed")
);

export const closeConnectionImmediately = (connection: Connection) => {
  try {
    connection.close(0n, closeReason);
  } catch {
    // The connection is already closed or no longer usable.
  }
};

export const closeConnection = (connection: Connection) =>
  Effect.sync(() => closeConnectionImmediately(connection));

export const closeEndpoint = (endpoint: Endpoint) =>
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

export const refuseIncoming = (incoming: Incoming) =>
  Effect.tryPromise({
    catch: () => undefined,
    try: () => incoming.refuse(),
  }).pipe(Effect.catch(() => Effect.void));

export const withDeadline = <A, E, R>(
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

interface BindableEndpointBuilder {
  readonly bind: () => Promise<Endpoint>;
}

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

export const acquireEndpoint = <E>(
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

export type IrohReachability = "direct-only" | "relay-only" | "direct-or-relay";

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
        return new EndpointAddrClass(address.id(), null, directAddresses);
      }
      if (reachability === "relay-only") {
        return new EndpointAddrClass(address.id(), relayUrl, []);
      }
      return new EndpointAddrClass(address.id(), relayUrl, directAddresses);
    },
  });
};
