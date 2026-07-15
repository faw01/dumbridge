import type { Duration, Effect, Option, Scope } from "effect";
import { Schema } from "effect";

const BridgeDeadlineOperation = Schema.Literals([
  "accept",
  "connect",
  "finish",
  "listen",
  "read",
  "write",
]);

export class BridgeAcceptError extends Schema.TaggedErrorClass<BridgeAcceptError>()(
  "BridgeAcceptError",
  {
    message: Schema.String,
  }
) {}

export class BridgeConnectError extends Schema.TaggedErrorClass<BridgeConnectError>()(
  "BridgeConnectError",
  {
    message: Schema.String,
  }
) {}

export class BridgeDeadlineExceededError extends Schema.TaggedErrorClass<BridgeDeadlineExceededError>()(
  "BridgeDeadlineExceededError",
  {
    message: Schema.String,
    operation: BridgeDeadlineOperation,
  }
) {}

// A dial against a locator with no relay cannot fall back; the failure is
// branded so callers can fail fast instead of retrying a hopeless holepunch.
export class BridgeDirectConnectError extends Schema.TaggedErrorClass<BridgeDirectConnectError>()(
  "BridgeDirectConnectError",
  {
    message: Schema.String,
  }
) {}

export class BridgeFinishError extends Schema.TaggedErrorClass<BridgeFinishError>()(
  "BridgeFinishError",
  {
    message: Schema.String,
  }
) {}

export class BridgeListenError extends Schema.TaggedErrorClass<BridgeListenError>()(
  "BridgeListenError",
  {
    message: Schema.String,
  }
) {}

export class BridgeListenerClosedError extends Schema.TaggedErrorClass<BridgeListenerClosedError>()(
  "BridgeListenerClosedError",
  {
    message: Schema.String,
  }
) {}

export class BridgeLocatorInvalidError extends Schema.TaggedErrorClass<BridgeLocatorInvalidError>()(
  "BridgeLocatorInvalidError",
  {
    message: Schema.String,
  }
) {}

export class BridgeProxyUnsupportedError extends Schema.TaggedErrorClass<BridgeProxyUnsupportedError>()(
  "BridgeProxyUnsupportedError",
  {
    message: Schema.String,
    requested: Schema.Literals(["environment", "url"]),
  }
) {}

export class BridgeProxyConfigurationError extends Schema.TaggedErrorClass<BridgeProxyConfigurationError>()(
  "BridgeProxyConfigurationError",
  {
    message: Schema.String,
    requested: Schema.Literals(["environment", "url"]),
  }
) {}

export class BridgeReadError extends Schema.TaggedErrorClass<BridgeReadError>()(
  "BridgeReadError",
  {
    message: Schema.String,
  }
) {}

export class BridgeWriteError extends Schema.TaggedErrorClass<BridgeWriteError>()(
  "BridgeWriteError",
  {
    message: Schema.String,
  }
) {}

export class BridgeLocator {
  readonly #encoded: string;

  private constructor(encoded: string) {
    this.#encoded = encoded;
  }

  static fromString(encoded: string) {
    return new BridgeLocator(encoded);
  }

  toString() {
    return this.#encoded;
  }
}

export interface BridgeDeadlines {
  readonly accept: Duration.Input;
  readonly connect: Duration.Input;
  readonly io: Duration.Input;
  readonly listen: Duration.Input;
}

// The path selected when the session was established. Iroh may later upgrade
// a relayed connection to a direct one; the snapshot is not re-observed.
export type ConnectionPath = "direct" | "relay" | "unknown";

export interface BridgeSession {
  readonly close: Effect.Effect<void>;
  readonly connectionPath: ConnectionPath;
  readonly finish: Effect.Effect<
    void,
    BridgeFinishError | BridgeDeadlineExceededError
  >;
  readonly read: Effect.Effect<
    Option.Option<Uint8Array>,
    BridgeReadError | BridgeDeadlineExceededError
  >;
  readonly write: (
    bytes: Uint8Array
  ) => Effect.Effect<void, BridgeWriteError | BridgeDeadlineExceededError>;
}

export interface BridgeListener {
  readonly accept: Effect.Effect<
    BridgeSession,
    BridgeAcceptError | BridgeDeadlineExceededError | BridgeListenerClosedError,
    Scope.Scope
  >;
  readonly locator: BridgeLocator;
}

export interface BridgeTransport {
  readonly connect: (
    locator: BridgeLocator
  ) => Effect.Effect<
    BridgeSession,
    | BridgeConnectError
    | BridgeDeadlineExceededError
    | BridgeDirectConnectError
    | BridgeLocatorInvalidError
    | BridgeProxyConfigurationError
    | BridgeProxyUnsupportedError,
    Scope.Scope
  >;
  readonly listen: Effect.Effect<
    BridgeListener,
    | BridgeDeadlineExceededError
    | BridgeListenError
    | BridgeProxyConfigurationError
    | BridgeProxyUnsupportedError,
    Scope.Scope
  >;
}
