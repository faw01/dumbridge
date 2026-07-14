import { randomBytes, timingSafeEqual } from "node:crypto";
import { Encoding, Result, Schema } from "effect";

const bridgeKeyPrefix = "dumbridge1_";
const capabilityByteLength = 32;
const maximumBridgeKeyLength = 16_384;
const maximumLocatorLength = 8192;

const CapabilitySchema = Schema.Uint8Array.check(
  Schema.isLengthBetween(capabilityByteLength, capabilityByteLength)
).pipe(Schema.brand("@Dumbridge/Capability"));

export const CapabilityTextSchema = Schema.String.check(
  Schema.isLengthBetween(43, 43),
  Schema.isBase64Url()
);

const BridgeKeySchema = Schema.String.check(
  Schema.isStartsWith(bridgeKeyPrefix),
  Schema.isMaxLength(maximumBridgeKeyLength)
).pipe(Schema.brand("@Dumbridge/BridgeKey"));

const BridgeKeyPayloadSchema = Schema.Struct({
  capability: CapabilityTextSchema,
  locator: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximumLocatorLength)
  ),
  transport: Schema.Literal("iroh"),
  version: Schema.Literal(1),
});

const BridgeKeyPayloadJson = Schema.fromJsonString(BridgeKeyPayloadSchema);

export type BridgeKey = typeof BridgeKeySchema.Type;
export type Capability = typeof CapabilitySchema.Type;

export interface BridgeKeyInput {
  readonly capability: Capability;
  readonly locator: string;
  readonly transport: "iroh";
}

export interface BridgeKeyContents extends BridgeKeyInput {
  readonly version: 1;
}

class InvalidCapabilityError extends Schema.TaggedErrorClass<InvalidCapabilityError>()(
  "InvalidCapabilityError",
  {
    message: Schema.String,
    reason: Schema.Literals(["encoding", "length"]),
  }
) {}

class InvalidBridgeKeyError extends Schema.TaggedErrorClass<InvalidBridgeKeyError>()(
  "InvalidBridgeKeyError",
  {
    message: Schema.String,
    reason: Schema.Literals(["encoding", "payload", "prefix", "size"]),
  }
) {}

export type BridgeKeyError = InvalidBridgeKeyError | InvalidCapabilityError;

export const redactBridgeKey = (_link: string): string =>
  `${bridgeKeyPrefix}[REDACTED]`;

export const capabilitiesEqual = (
  left: Uint8Array,
  right: Uint8Array
): boolean =>
  left.byteLength === capabilityByteLength &&
  right.byteLength === capabilityByteLength &&
  timingSafeEqual(left, right);

export const makeCapability = (
  bytes: Uint8Array
): Result.Result<Capability, InvalidCapabilityError> => {
  const decoded = Schema.decodeUnknownResult(CapabilitySchema)(
    Uint8Array.from(bytes)
  );
  if (Result.isFailure(decoded)) {
    return Result.fail(
      new InvalidCapabilityError({
        message: "Capability must contain exactly 32 bytes.",
        reason: "length",
      })
    );
  }
  return Result.succeed(decoded.success);
};

export const mintCapability = (): Capability => {
  const capability = makeCapability(randomBytes(capabilityByteLength));
  if (Result.isFailure(capability)) {
    throw capability.failure;
  }
  return capability.success;
};

export const encodeCapability = (
  capability: Uint8Array
): Result.Result<string, InvalidCapabilityError> => {
  const validated = makeCapability(capability);
  if (Result.isFailure(validated)) {
    return Result.fail(validated.failure);
  }
  return Result.succeed(Encoding.encodeBase64Url(validated.success));
};

export const parseCapability = (
  encoded: string
): Result.Result<Capability, InvalidCapabilityError> => {
  const text = Schema.decodeUnknownResult(CapabilityTextSchema)(encoded);
  if (Result.isFailure(text)) {
    return Result.fail(
      new InvalidCapabilityError({
        message: "Capability has an invalid encoding.",
        reason: "encoding",
      })
    );
  }

  const decoded = Encoding.decodeBase64Url(text.success);
  if (Result.isFailure(decoded)) {
    return Result.fail(
      new InvalidCapabilityError({
        message: "Capability has an invalid encoding.",
        reason: "encoding",
      })
    );
  }
  return makeCapability(decoded.success);
};

export const encodeBridgeKey = (
  input: BridgeKeyInput
): Result.Result<BridgeKey, BridgeKeyError> => {
  const capability = encodeCapability(input.capability);
  if (Result.isFailure(capability)) {
    return Result.fail(capability.failure);
  }

  const payload = Schema.encodeResult(BridgeKeyPayloadJson)({
    capability: capability.success,
    locator: input.locator,
    transport: input.transport,
    version: 1,
  });
  if (Result.isFailure(payload)) {
    return Result.fail(
      new InvalidBridgeKeyError({
        message: "Bridge key payload is invalid.",
        reason: "payload",
      })
    );
  }

  const encoded = `${bridgeKeyPrefix}${Encoding.encodeBase64Url(payload.success)}`;
  const link = Schema.decodeUnknownResult(BridgeKeySchema)(encoded);
  if (Result.isFailure(link)) {
    return Result.fail(
      new InvalidBridgeKeyError({
        message: "Bridge key exceeds the maximum length.",
        reason: "size",
      })
    );
  }
  return Result.succeed(link.success);
};

export const parseBridgeKey = (
  link: string
): Result.Result<BridgeKeyContents, BridgeKeyError> => {
  if (!link.startsWith(bridgeKeyPrefix)) {
    return Result.fail(
      new InvalidBridgeKeyError({
        message: "Bridge key has an invalid prefix.",
        reason: "prefix",
      })
    );
  }
  if (link.length > maximumBridgeKeyLength) {
    return Result.fail(
      new InvalidBridgeKeyError({
        message: "Bridge key exceeds the maximum length.",
        reason: "size",
      })
    );
  }

  const payloadBytes = Encoding.decodeBase64Url(
    link.slice(bridgeKeyPrefix.length)
  );
  if (Result.isFailure(payloadBytes)) {
    return Result.fail(
      new InvalidBridgeKeyError({
        message: "Bridge key has an invalid encoding.",
        reason: "encoding",
      })
    );
  }

  let payloadText: string;
  try {
    payloadText = new TextDecoder("utf-8", { fatal: true }).decode(
      payloadBytes.success
    );
  } catch {
    return Result.fail(
      new InvalidBridgeKeyError({
        message: "Bridge key has an invalid encoding.",
        reason: "encoding",
      })
    );
  }

  const payload = Schema.decodeUnknownResult(BridgeKeyPayloadJson)(
    payloadText,
    {
      onExcessProperty: "error",
    }
  );
  if (Result.isFailure(payload)) {
    return Result.fail(
      new InvalidBridgeKeyError({
        message: "Bridge key payload is invalid.",
        reason: "payload",
      })
    );
  }

  const capability = parseCapability(payload.success.capability);
  if (Result.isFailure(capability)) {
    return Result.fail(capability.failure);
  }

  return Result.succeed({
    capability: capability.success,
    locator: payload.success.locator,
    transport: payload.success.transport,
    version: payload.success.version,
  });
};
