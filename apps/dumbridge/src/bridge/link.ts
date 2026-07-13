import { randomBytes, timingSafeEqual } from "node:crypto";
import { Encoding, Result, Schema } from "effect";

const bridgeLinkPrefix = "dumbridge1_";
const capabilityByteLength = 32;
const maximumBridgeLinkLength = 16_384;
const maximumLocatorLength = 8192;

const CapabilitySchema = Schema.Uint8Array.check(
  Schema.isLengthBetween(capabilityByteLength, capabilityByteLength)
).pipe(Schema.brand("@Dumbridge/Capability"));

export const CapabilityTextSchema = Schema.String.check(
  Schema.isLengthBetween(43, 43),
  Schema.isBase64Url()
);

const BridgeLinkSchema = Schema.String.check(
  Schema.isStartsWith(bridgeLinkPrefix),
  Schema.isMaxLength(maximumBridgeLinkLength)
).pipe(Schema.brand("@Dumbridge/BridgeLink"));

const BridgeLinkPayloadSchema = Schema.Struct({
  capability: CapabilityTextSchema,
  locator: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximumLocatorLength)
  ),
  transport: Schema.Literal("iroh"),
  version: Schema.Literal(1),
});

const BridgeLinkPayloadJson = Schema.fromJsonString(BridgeLinkPayloadSchema);

export type BridgeLink = typeof BridgeLinkSchema.Type;
export type Capability = typeof CapabilitySchema.Type;

export interface BridgeLinkInput {
  readonly capability: Capability;
  readonly locator: string;
  readonly transport: "iroh";
}

export interface BridgeLinkContents extends BridgeLinkInput {
  readonly version: 1;
}

export class InvalidCapabilityError extends Schema.TaggedErrorClass<InvalidCapabilityError>()(
  "InvalidCapabilityError",
  {
    message: Schema.String,
    reason: Schema.Literals(["encoding", "length"]),
  }
) {}

export class InvalidBridgeLinkError extends Schema.TaggedErrorClass<InvalidBridgeLinkError>()(
  "InvalidBridgeLinkError",
  {
    message: Schema.String,
    reason: Schema.Literals(["encoding", "payload", "prefix", "size"]),
  }
) {}

export type BridgeLinkError = InvalidBridgeLinkError | InvalidCapabilityError;

export const redactBridgeLink = (_link: string): string =>
  `${bridgeLinkPrefix}[REDACTED]`;

export const capabilitiesEqual = (
  left: Capability,
  right: Capability
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

export const encodeBridgeLink = (
  input: BridgeLinkInput
): Result.Result<BridgeLink, BridgeLinkError> => {
  const capability = encodeCapability(input.capability);
  if (Result.isFailure(capability)) {
    return Result.fail(capability.failure);
  }

  const payload = Schema.encodeResult(BridgeLinkPayloadJson)({
    capability: capability.success,
    locator: input.locator,
    transport: input.transport,
    version: 1,
  });
  if (Result.isFailure(payload)) {
    return Result.fail(
      new InvalidBridgeLinkError({
        message: "Bridge link payload is invalid.",
        reason: "payload",
      })
    );
  }

  const encoded = `${bridgeLinkPrefix}${Encoding.encodeBase64Url(payload.success)}`;
  const link = Schema.decodeUnknownResult(BridgeLinkSchema)(encoded);
  if (Result.isFailure(link)) {
    return Result.fail(
      new InvalidBridgeLinkError({
        message: "Bridge link exceeds the maximum length.",
        reason: "size",
      })
    );
  }
  return Result.succeed(link.success);
};

export const parseBridgeLink = (
  link: string
): Result.Result<BridgeLinkContents, BridgeLinkError> => {
  if (!link.startsWith(bridgeLinkPrefix)) {
    return Result.fail(
      new InvalidBridgeLinkError({
        message: "Bridge link has an invalid prefix.",
        reason: "prefix",
      })
    );
  }
  if (link.length > maximumBridgeLinkLength) {
    return Result.fail(
      new InvalidBridgeLinkError({
        message: "Bridge link exceeds the maximum length.",
        reason: "size",
      })
    );
  }

  const payloadBytes = Encoding.decodeBase64Url(
    link.slice(bridgeLinkPrefix.length)
  );
  if (Result.isFailure(payloadBytes)) {
    return Result.fail(
      new InvalidBridgeLinkError({
        message: "Bridge link has an invalid encoding.",
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
      new InvalidBridgeLinkError({
        message: "Bridge link has an invalid encoding.",
        reason: "encoding",
      })
    );
  }

  const payload = Schema.decodeUnknownResult(BridgeLinkPayloadJson)(
    payloadText,
    {
      onExcessProperty: "error",
    }
  );
  if (Result.isFailure(payload)) {
    return Result.fail(
      new InvalidBridgeLinkError({
        message: "Bridge link payload is invalid.",
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
