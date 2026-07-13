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
    cause: Schema.String,
    message: Schema.String,
  }
) {}

export class BridgeConnectError extends Schema.TaggedErrorClass<BridgeConnectError>()(
  "BridgeConnectError",
  {
    cause: Schema.String,
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

export class BridgeFinishError extends Schema.TaggedErrorClass<BridgeFinishError>()(
  "BridgeFinishError",
  {
    cause: Schema.String,
    message: Schema.String,
  }
) {}

export class BridgeListenError extends Schema.TaggedErrorClass<BridgeListenError>()(
  "BridgeListenError",
  {
    cause: Schema.String,
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

export class BridgeReadError extends Schema.TaggedErrorClass<BridgeReadError>()(
  "BridgeReadError",
  {
    cause: Schema.String,
    message: Schema.String,
  }
) {}

export class BridgeWriteError extends Schema.TaggedErrorClass<BridgeWriteError>()(
  "BridgeWriteError",
  {
    cause: Schema.String,
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

export interface BridgeSession {
  readonly close: Effect.Effect<void>;
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
    | BridgeLocatorInvalidError
    | BridgeProxyUnsupportedError,
    Scope.Scope
  >;
  readonly listen: Effect.Effect<
    BridgeListener,
    | BridgeDeadlineExceededError
    | BridgeListenError
    | BridgeProxyUnsupportedError,
    Scope.Scope
  >;
}
