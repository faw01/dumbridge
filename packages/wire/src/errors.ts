import { Result, Schema } from "effect";
import {
  maximumFileBytes,
  maximumManifestEntries,
  maximumTransferBytes,
} from "./limits";
import {
  NonNegativeInt,
  type PullManifestViolation,
  type ValidatedPullManifest,
  validatePullManifest,
} from "./pull-manifest";

export interface WireSessionLimits {
  readonly maxFileBytes: number;
  readonly maxFramesPerSession: number;
  readonly maxManifestEntries: number;
  readonly maxOutputBytes: number;
  readonly maxTransferBytes: number;
}

export const defaultSessionLimits: WireSessionLimits = {
  maxFileBytes: maximumFileBytes,
  maxFramesPerSession: 65_536,
  maxManifestEntries: maximumManifestEntries,
  maxOutputBytes: 1024 * 1024,
  maxTransferBytes: maximumTransferBytes,
};

const sessionLimitNames = [
  "maxFileBytes",
  "maxFramesPerSession",
  "maxManifestEntries",
  "maxOutputBytes",
  "maxTransferBytes",
] satisfies readonly (keyof WireSessionLimits)[];

const LimitName = Schema.Literals([
  "file-bytes",
  "frames-per-session",
  "manifest-entries",
  "output-bytes",
  "transfer-bytes",
]);
type LimitName = typeof LimitName.Type;

export class FrameTooLargeError extends Schema.TaggedErrorClass<FrameTooLargeError>()(
  "FrameTooLargeError",
  {
    declaredBytes: NonNegativeInt,
    maximumBytes: NonNegativeInt,
    message: Schema.String,
  }
) {}

class MalformedFrameError extends Schema.TaggedErrorClass<MalformedFrameError>()(
  "MalformedFrameError",
  {
    message: Schema.String,
    reason: Schema.Literals(["header", "length", "schema", "utf8"]),
  }
) {}

export class IncompleteFrameError extends Schema.TaggedErrorClass<IncompleteFrameError>()(
  "IncompleteFrameError",
  {
    message: Schema.String,
    receivedBytes: NonNegativeInt,
  }
) {}

export class UnsupportedProtocolError extends Schema.TaggedErrorClass<UnsupportedProtocolError>()(
  "UnsupportedProtocolError",
  { message: Schema.String }
) {}

export class UnknownFrameTypeError extends Schema.TaggedErrorClass<UnknownFrameTypeError>()(
  "UnknownFrameTypeError",
  { message: Schema.String }
) {}

export class AuthenticationError extends Schema.TaggedErrorClass<AuthenticationError>()(
  "AuthenticationError",
  { message: Schema.String }
) {}

class IllegalFrameError extends Schema.TaggedErrorClass<IllegalFrameError>()(
  "IllegalFrameError",
  {
    message: Schema.String,
    reason: Schema.Literals(["manifest", "offset", "order", "path", "payload"]),
  }
) {}

export class IncompleteSessionError extends Schema.TaggedErrorClass<IncompleteSessionError>()(
  "IncompleteSessionError",
  { message: Schema.String }
) {}

class WireLimitExceededError extends Schema.TaggedErrorClass<WireLimitExceededError>()(
  "WireLimitExceededError",
  {
    limit: LimitName,
    maximum: NonNegativeInt,
    message: Schema.String,
    observed: NonNegativeInt,
  }
) {}

export class InvalidWireLimitError extends Schema.TaggedErrorClass<InvalidWireLimitError>()(
  "InvalidWireLimitError",
  {
    limit: Schema.String,
    message: Schema.String,
  }
) {}

export type WireEncodeError =
  | FrameTooLargeError
  | IllegalFrameError
  | MalformedFrameError
  | WireLimitExceededError;

export type WireDecodeError =
  | WireEncodeError
  | AuthenticationError
  | IncompleteFrameError
  | IncompleteSessionError
  | UnsupportedProtocolError
  | UnknownFrameTypeError;

export const malformed = (
  reason: MalformedFrameError["reason"],
  message: string
) => new MalformedFrameError({ message, reason });

export const illegal = (reason: IllegalFrameError["reason"], message: string) =>
  new IllegalFrameError({ message, reason });

export const limitExceeded = (
  limit: LimitName,
  maximum: number,
  observed: number
) =>
  new WireLimitExceededError({
    limit,
    maximum,
    message: "Wire session exceeded a configured limit.",
    observed,
  });

const manifestViolationError = (
  violation: PullManifestViolation
): IllegalFrameError | WireLimitExceededError => {
  switch (violation.kind) {
    case "limit":
      return limitExceeded(
        violation.limit,
        violation.maximum,
        violation.observed
      );
    case "shape":
      return illegal(
        "manifest",
        "Pull manifest does not match the wire schema."
      );
    case "name":
      return illegal("manifest", "Pull manifest name is not canonical.");
    case "entry-path":
    case "order":
      return illegal(
        "manifest",
        "Pull manifest paths are not canonical and ordered."
      );
    case "parents":
      return illegal("manifest", "Pull manifest omits a parent directory.");
    case "totals":
      return illegal(
        "manifest",
        "Pull manifest total does not match its files."
      );
    case "file-shape":
      return illegal(
        "manifest",
        "File manifest does not describe one named file."
      );
    default:
      return illegal("manifest", "Pull manifest is invalid.");
  }
};

export const validateManifest = (
  input: unknown,
  limits: WireSessionLimits
): Result.Result<
  ValidatedPullManifest,
  IllegalFrameError | WireLimitExceededError
> => {
  const validated = validatePullManifest(input, {
    maxFileBytes: limits.maxFileBytes,
    maxManifestEntries: limits.maxManifestEntries,
    maxTransferBytes: limits.maxTransferBytes,
  });
  if (Result.isSuccess(validated)) {
    return Result.succeed(validated.success);
  }
  return Result.fail(manifestViolationError(validated.failure));
};

export const resolveLimits = (
  overrides: Partial<WireSessionLimits>
): Result.Result<WireSessionLimits, InvalidWireLimitError> => {
  const limits = { ...defaultSessionLimits, ...overrides };
  for (const name of sessionLimitNames) {
    const value = limits[name];
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > defaultSessionLimits[name]
    ) {
      return Result.fail(
        new InvalidWireLimitError({
          limit: name,
          message:
            "Wire limits must be positive integers within protocol bounds.",
        })
      );
    }
  }
  return Result.succeed(limits);
};
