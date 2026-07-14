import { Result, Schema } from "effect";
import { maximumManifestEntries, NonNegativeInt } from "./protocol";

export interface WireSessionLimits {
  readonly maxFileBytes: number;
  readonly maxFramesPerSession: number;
  readonly maxManifestEntries: number;
  readonly maxOutputBytes: number;
  readonly maxTransferBytes: number;
}

export const defaultSessionLimits: WireSessionLimits = {
  maxFileBytes: 1024 * 1024 * 1024,
  maxFramesPerSession: 65_536,
  maxManifestEntries: maximumManifestEntries,
  maxOutputBytes: 1024 * 1024,
  maxTransferBytes: 2 * 1024 * 1024 * 1024,
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

export class MalformedFrameError extends Schema.TaggedErrorClass<MalformedFrameError>()(
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

export class IllegalFrameError extends Schema.TaggedErrorClass<IllegalFrameError>()(
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

export class WireLimitExceededError extends Schema.TaggedErrorClass<WireLimitExceededError>()(
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
