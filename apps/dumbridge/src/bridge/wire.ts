import { Result, Schema } from "effect";
import {
  type Capability,
  CapabilityTextSchema,
  capabilitiesEqual,
  encodeCapability,
  parseCapability,
} from "./link";

const protocol = "dumbridge/1" as const;
const lengthPrefixBytes = 4;
const maximumFrameBytes = 1024 * 1024;
const maximumHeaderBytes = maximumFrameBytes - lengthPrefixBytes;
const maximumManifestEntries = 10_000;
const maximumPathCharacters = 4096;
const maximumScriptCharacters = 64 * 1024;
const windowsDrivePattern = /^[a-z]:/i;

const frameTypeNames = [
  "auth",
  "complete",
  "exit",
  "file-chunk",
  "file-end",
  "file-start",
  "manifest",
  "pull",
  "run",
  "stderr",
  "stdout",
] as const;
const knownHeaderTypes = new Set<string>(frameTypeNames);

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Path = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maximumPathCharacters)
);
const Digest = Schema.String.check(
  Schema.isLengthBetween(64, 64),
  Schema.isPattern(/^[a-f0-9]{64}$/)
);

const FileEntrySchema = Schema.Struct({
  digest: Digest,
  kind: Schema.Literal("file"),
  path: Path,
  size: NonNegativeInt,
});
const DirectoryEntrySchema = Schema.Struct({
  kind: Schema.Literal("directory"),
  path: Path,
});
const PullManifestSchema = Schema.Struct({
  digestAlgorithm: Schema.Literal("sha256"),
  entries: Schema.Array(
    Schema.Union([FileEntrySchema, DirectoryEntrySchema])
  ).check(Schema.isMaxLength(maximumManifestEntries)),
  kind: Schema.Literals(["directory", "file"]),
  name: Path,
  totalBytes: NonNegativeInt,
});

const AuthHeaderSchema = Schema.Struct({
  capability: CapabilityTextSchema,
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("auth"),
});
const RunHeaderSchema = Schema.Struct({
  protocol: Schema.Literal(protocol),
  script: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximumScriptCharacters)
  ),
  type: Schema.Literal("run"),
});
const PullHeaderSchema = Schema.Struct({
  protocol: Schema.Literal(protocol),
  remotePath: Path,
  type: Schema.Literal("pull"),
});
const StdoutHeaderSchema = Schema.Struct({
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("stdout"),
});
const StderrHeaderSchema = Schema.Struct({
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("stderr"),
});
const ExitHeaderSchema = Schema.Struct({
  code: Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: 0 })),
  protocol: Schema.Literal(protocol),
  truncated: Schema.Boolean,
  type: Schema.Literal("exit"),
});
const ManifestHeaderSchema = Schema.Struct({
  manifest: PullManifestSchema,
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("manifest"),
});
const FileStartHeaderSchema = Schema.Struct({
  path: Path,
  protocol: Schema.Literal(protocol),
  size: NonNegativeInt,
  type: Schema.Literal("file-start"),
});
const FileChunkHeaderSchema = Schema.Struct({
  offset: NonNegativeInt,
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("file-chunk"),
});
const FileEndHeaderSchema = Schema.Struct({
  digest: Digest,
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("file-end"),
});
const CompleteHeaderSchema = Schema.Struct({
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("complete"),
});

const WireHeaderSchema = Schema.Union([
  AuthHeaderSchema,
  RunHeaderSchema,
  PullHeaderSchema,
  StdoutHeaderSchema,
  StderrHeaderSchema,
  ExitHeaderSchema,
  ManifestHeaderSchema,
  FileStartHeaderSchema,
  FileChunkHeaderSchema,
  FileEndHeaderSchema,
  CompleteHeaderSchema,
]);
const WireHeaderJson = Schema.fromJsonString(WireHeaderSchema);
const HeaderEnvelopeSchema = Schema.Struct({
  protocol: Schema.String.check(Schema.isMaxLength(128)),
  type: Schema.String.check(Schema.isMaxLength(128)),
});

type WireHeader = typeof WireHeaderSchema.Type;
export type WirePullManifest = typeof PullManifestSchema.Type;
type WirePullFileEntry = Extract<
  WirePullManifest["entries"][number],
  { readonly kind: "file" }
>;

export type BridgeRequest =
  | { readonly script: string; readonly type: "run" }
  | { readonly remotePath: string; readonly type: "pull" };

export type RunResponseEvent =
  | { readonly payload: Uint8Array; readonly type: "stdout" | "stderr" }
  | {
      readonly code: number;
      readonly truncated: boolean;
      readonly type: "exit";
    };

export type PullResponseEvent =
  | { readonly manifest: WirePullManifest; readonly type: "manifest" }
  | {
      readonly path: string;
      readonly size: number;
      readonly type: "file-start";
    }
  | {
      readonly offset: number;
      readonly payload: Uint8Array;
      readonly type: "file-chunk";
    }
  | { readonly digest: string; readonly type: "file-end" }
  | { readonly type: "complete" };

export type WireFrame =
  | { readonly capability: Capability; readonly type: "auth" }
  | BridgeRequest
  | RunResponseEvent
  | PullResponseEvent;

export interface WireSessionLimits {
  readonly maxFileBytes: number;
  readonly maxFramesPerPush: number;
  readonly maxInputBytes: number;
  readonly maxManifestEntries: number;
  readonly maxOutputBytes: number;
  readonly maxTransferBytes: number;
}

const defaultSessionLimits: WireSessionLimits = {
  maxFileBytes: 1024 * 1024 * 1024,
  maxFramesPerPush: 64,
  maxInputBytes: maximumFrameBytes + lengthPrefixBytes,
  maxManifestEntries: maximumManifestEntries,
  maxOutputBytes: 1024 * 1024,
  maxTransferBytes: 2 * 1024 * 1024 * 1024,
};

const sessionLimitNames = [
  "maxFileBytes",
  "maxFramesPerPush",
  "maxInputBytes",
  "maxManifestEntries",
  "maxOutputBytes",
  "maxTransferBytes",
] satisfies readonly (keyof WireSessionLimits)[];

const LimitName = Schema.Literals([
  "file-bytes",
  "frames-per-push",
  "input-bytes",
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

export interface WireSession<A> {
  readonly finish: () => Result.Result<void, WireDecodeError>;
  readonly push: (
    chunk: Uint8Array
  ) => Result.Result<readonly A[], WireDecodeError>;
}

export type RequestSession = WireSession<BridgeRequest>;
export type RunResponseSession = WireSession<RunResponseEvent>;
export type PullResponseSession = WireSession<PullResponseEvent>;

interface RawFrame {
  readonly header: WireHeader;
  readonly payload: Uint8Array;
}

interface ValidatedManifest {
  readonly files: readonly WirePullFileEntry[];
  readonly manifest: WirePullManifest;
}

interface ValidatedManifestEntries {
  readonly files: readonly WirePullFileEntry[];
  readonly totalBytes: number;
}

type SessionEvent<A> =
  | { readonly emit: false }
  | { readonly emit: true; readonly value: A };

const noEvent: SessionEvent<never> = { emit: false };
const emit = <A>(value: A): SessionEvent<A> => ({ emit: true, value });

const malformed = (reason: MalformedFrameError["reason"], message: string) =>
  new MalformedFrameError({ message, reason });

const illegal = (reason: IllegalFrameError["reason"], message: string) =>
  new IllegalFrameError({ message, reason });

const limitExceeded = (limit: LimitName, maximum: number, observed: number) =>
  new WireLimitExceededError({
    limit,
    maximum,
    message: "Wire session exceeded a configured limit.",
    observed,
  });

const resolveLimits = (
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

const canonicalPath = (path: string, singlePart = false): boolean => {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    windowsDrivePattern.test(path)
  ) {
    return false;
  }
  const parts = path.split("/");
  return (
    (!singlePart || parts.length === 1) &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..")
  );
};

const parentsAreDeclared = (
  path: string,
  directories: ReadonlySet<string>
): boolean => {
  let separator = path.indexOf("/");
  while (separator !== -1) {
    if (!directories.has(path.slice(0, separator))) {
      return false;
    }
    separator = path.indexOf("/", separator + 1);
  }
  return true;
};

const validateManifestEntries = (
  entries: WirePullManifest["entries"],
  limits: WireSessionLimits
): Result.Result<
  ValidatedManifestEntries,
  IllegalFrameError | WireLimitExceededError
> => {
  const files: WirePullFileEntry[] = [];
  const directories = new Set<string>();
  let previousPath: string | undefined;
  let totalBytes = 0;
  for (const entry of entries) {
    if (
      !canonicalPath(entry.path) ||
      (previousPath !== undefined && previousPath >= entry.path)
    ) {
      return Result.fail(
        illegal(
          "manifest",
          "Pull manifest paths are not canonical and ordered."
        )
      );
    }
    previousPath = entry.path;
    if (!parentsAreDeclared(entry.path, directories)) {
      return Result.fail(
        illegal("manifest", "Pull manifest omits a parent directory.")
      );
    }
    if (entry.kind === "directory") {
      directories.add(entry.path);
      continue;
    }
    if (entry.size > limits.maxFileBytes) {
      return Result.fail(
        limitExceeded("file-bytes", limits.maxFileBytes, entry.size)
      );
    }
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes)) {
      return Result.fail(
        limitExceeded(
          "transfer-bytes",
          limits.maxTransferBytes,
          Number.MAX_SAFE_INTEGER
        )
      );
    }
    if (totalBytes > limits.maxTransferBytes) {
      return Result.fail(
        limitExceeded("transfer-bytes", limits.maxTransferBytes, totalBytes)
      );
    }
    files.push(entry);
  }
  return Result.succeed({ files, totalBytes });
};

const validateManifest = (
  input: WirePullManifest,
  limits: WireSessionLimits
): Result.Result<
  ValidatedManifest,
  IllegalFrameError | WireLimitExceededError
> => {
  const decoded = Schema.decodeUnknownResult(PullManifestSchema)(input, {
    onExcessProperty: "error",
  });
  if (Result.isFailure(decoded)) {
    return Result.fail(
      illegal("manifest", "Pull manifest does not match the wire schema.")
    );
  }
  const manifest = decoded.success;
  if (!canonicalPath(manifest.name, true)) {
    return Result.fail(
      illegal("manifest", "Pull manifest name is not canonical.")
    );
  }
  if (manifest.entries.length > limits.maxManifestEntries) {
    return Result.fail(
      limitExceeded(
        "manifest-entries",
        limits.maxManifestEntries,
        manifest.entries.length
      )
    );
  }

  const entries = validateManifestEntries(manifest.entries, limits);
  if (Result.isFailure(entries)) {
    return Result.fail(entries.failure);
  }

  if (manifest.totalBytes !== entries.success.totalBytes) {
    return Result.fail(
      illegal("manifest", "Pull manifest total does not match its files.")
    );
  }
  if (
    manifest.kind === "file" &&
    (manifest.entries.length !== 1 ||
      manifest.entries[0]?.kind !== "file" ||
      manifest.entries[0].path !== manifest.name)
  ) {
    return Result.fail(
      illegal("manifest", "File manifest does not describe one named file.")
    );
  }

  return Result.succeed({ files: entries.success.files, manifest });
};

const writeUint32 = (target: Uint8Array, offset: number, value: number) => {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(
    offset,
    value,
    false
  );
};

const readUint32 = (source: Uint8Array, offset = 0) =>
  new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(
    offset,
    false
  );

const encodeRawFrame = (
  frame: RawFrame
): Result.Result<Uint8Array, WireEncodeError> => {
  const headerJson = Schema.encodeResult(WireHeaderJson)(frame.header, {
    onExcessProperty: "error",
  });
  if (Result.isFailure(headerJson)) {
    return Result.fail(
      malformed("schema", "Frame header does not match the wire schema.")
    );
  }

  const headerBytes = new TextEncoder().encode(headerJson.success);
  if (headerBytes.byteLength > maximumHeaderBytes) {
    return Result.fail(
      new FrameTooLargeError({
        declaredBytes: headerBytes.byteLength,
        maximumBytes: maximumHeaderBytes,
        message: "Frame header exceeds the maximum size.",
      })
    );
  }

  const bodyLength =
    lengthPrefixBytes + headerBytes.byteLength + frame.payload.byteLength;
  if (bodyLength > maximumFrameBytes) {
    return Result.fail(
      new FrameTooLargeError({
        declaredBytes: bodyLength,
        maximumBytes: maximumFrameBytes,
        message: "Frame exceeds the maximum size.",
      })
    );
  }

  const encoded = new Uint8Array(lengthPrefixBytes + bodyLength);
  writeUint32(encoded, 0, bodyLength);
  writeUint32(encoded, lengthPrefixBytes, headerBytes.byteLength);
  encoded.set(headerBytes, lengthPrefixBytes * 2);
  encoded.set(frame.payload, lengthPrefixBytes * 2 + headerBytes.byteLength);
  return Result.succeed(encoded);
};

const frameToRaw = (
  frame: WireFrame
): Result.Result<RawFrame, WireEncodeError> => {
  const empty = new Uint8Array();
  switch (frame.type) {
    case "auth": {
      const capability = encodeCapability(frame.capability);
      if (Result.isFailure(capability)) {
        return Result.fail(
          malformed("schema", "Authentication frame is invalid.")
        );
      }
      return Result.succeed({
        header: { capability: capability.success, protocol, type: "auth" },
        payload: empty,
      });
    }
    case "run":
      return Result.succeed({
        header: { protocol, script: frame.script, type: "run" },
        payload: empty,
      });
    case "pull":
      if (!canonicalPath(frame.remotePath)) {
        return Result.fail(
          illegal("path", "Pull path must be canonical and relative.")
        );
      }
      return Result.succeed({
        header: { protocol, remotePath: frame.remotePath, type: "pull" },
        payload: empty,
      });
    case "stdout":
      return Result.succeed({
        header: { protocol, type: "stdout" },
        payload: frame.payload,
      });
    case "stderr":
      return Result.succeed({
        header: { protocol, type: "stderr" },
        payload: frame.payload,
      });
    case "exit":
      return Result.succeed({
        header: {
          code: frame.code,
          protocol,
          truncated: frame.truncated,
          type: "exit",
        },
        payload: empty,
      });
    case "manifest": {
      const manifest = validateManifest(frame.manifest, defaultSessionLimits);
      if (Result.isFailure(manifest)) {
        return Result.fail(manifest.failure);
      }
      return Result.succeed({
        header: {
          manifest: manifest.success.manifest,
          protocol,
          type: "manifest",
        },
        payload: empty,
      });
    }
    case "file-start":
      if (!canonicalPath(frame.path)) {
        return Result.fail(
          illegal("path", "File path must be canonical and relative.")
        );
      }
      if (frame.size > defaultSessionLimits.maxFileBytes) {
        return Result.fail(
          limitExceeded(
            "file-bytes",
            defaultSessionLimits.maxFileBytes,
            frame.size
          )
        );
      }
      return Result.succeed({
        header: {
          path: frame.path,
          protocol,
          size: frame.size,
          type: "file-start",
        },
        payload: empty,
      });
    case "file-chunk":
      if (frame.payload.byteLength === 0) {
        return Result.fail(
          illegal("payload", "File chunk payload must not be empty.")
        );
      }
      return Result.succeed({
        header: { offset: frame.offset, protocol, type: "file-chunk" },
        payload: frame.payload,
      });
    case "file-end":
      return Result.succeed({
        header: { digest: frame.digest, protocol, type: "file-end" },
        payload: empty,
      });
    case "complete":
      return Result.succeed({
        header: { protocol, type: "complete" },
        payload: empty,
      });
    default:
      return Result.fail(
        malformed("schema", "Frame does not match the wire interface.")
      );
  }
};

export const encodeFrame = (
  frame: WireFrame
): Result.Result<Uint8Array, WireEncodeError> => {
  const raw = frameToRaw(frame);
  if (Result.isFailure(raw)) {
    return Result.fail(raw.failure);
  }
  return encodeRawFrame(raw.success);
};

const decodeFrameBody = (
  body: Uint8Array
): Result.Result<RawFrame, WireDecodeError> => {
  if (body.byteLength < lengthPrefixBytes) {
    return Result.fail(
      malformed("length", "Frame body is shorter than its header prefix.")
    );
  }

  const headerLength = readUint32(body);
  if (
    headerLength === 0 ||
    headerLength > maximumHeaderBytes ||
    headerLength > body.byteLength - lengthPrefixBytes
  ) {
    return Result.fail(
      malformed("header", "Frame contains an invalid header length.")
    );
  }

  const headerEnd = lengthPrefixBytes + headerLength;
  let headerText: string;
  try {
    headerText = new TextDecoder("utf-8", { fatal: true }).decode(
      body.subarray(lengthPrefixBytes, headerEnd)
    );
  } catch {
    return Result.fail(malformed("utf8", "Frame header is not valid UTF-8."));
  }

  const json = Schema.decodeUnknownResult(Schema.UnknownFromJsonString)(
    headerText
  );
  if (Result.isFailure(json)) {
    return Result.fail(
      malformed("schema", "Frame header does not contain valid JSON.")
    );
  }

  const envelope = Schema.decodeUnknownResult(HeaderEnvelopeSchema)(
    json.success
  );
  if (Result.isFailure(envelope)) {
    return Result.fail(
      malformed("schema", "Frame header does not match the wire envelope.")
    );
  }
  if (envelope.success.protocol !== protocol) {
    return Result.fail(
      new UnsupportedProtocolError({
        message: "Frame uses an unsupported Dumbridge protocol.",
      })
    );
  }
  if (!knownHeaderTypes.has(envelope.success.type)) {
    return Result.fail(
      new UnknownFrameTypeError({
        message: "Frame uses an unknown header type.",
      })
    );
  }

  const header = Schema.decodeUnknownResult(WireHeaderSchema)(json.success, {
    onExcessProperty: "error",
  });
  if (Result.isFailure(header)) {
    return Result.fail(
      malformed("schema", "Frame header does not match the wire schema.")
    );
  }

  return Result.succeed({
    header: header.success,
    payload: body.slice(headerEnd),
  });
};

type ReaderState =
  | {
      readonly _tag: "failed";
      readonly error: WireDecodeError;
    }
  | {
      readonly _tag: "frame";
      readonly bytes: Uint8Array;
      offset: number;
    }
  | {
      readonly _tag: "prefix";
      readonly bytes: Uint8Array;
      offset: number;
    };

class IncrementalFrameReader {
  private state: ReaderState = {
    _tag: "prefix",
    bytes: new Uint8Array(lengthPrefixBytes),
    offset: 0,
  };

  finish(): Result.Result<void, WireDecodeError> {
    if (this.state._tag === "failed") {
      return Result.fail(this.state.error);
    }
    if (this.state._tag === "prefix" && this.state.offset === 0) {
      return Result.succeed(undefined);
    }
    return this.fail(
      new IncompleteFrameError({
        message: "Wire stream ended with an incomplete frame.",
        receivedBytes: this.state.offset,
      })
    );
  }

  push<A>(
    chunk: Uint8Array,
    limits: WireSessionLimits,
    consume: (
      frame: RawFrame
    ) => Result.Result<SessionEvent<A>, WireDecodeError>
  ): Result.Result<readonly A[], WireDecodeError> {
    if (this.state._tag === "failed") {
      return Result.fail(this.state.error);
    }
    if (chunk.byteLength > limits.maxInputBytes) {
      return this.fail(
        limitExceeded("input-bytes", limits.maxInputBytes, chunk.byteLength)
      );
    }

    const events: A[] = [];
    let chunkOffset = 0;
    let frames = 0;
    while (chunkOffset < chunk.byteLength) {
      const available = this.state.bytes.byteLength - this.state.offset;
      const copied = Math.min(available, chunk.byteLength - chunkOffset);
      this.state.bytes.set(
        chunk.subarray(chunkOffset, chunkOffset + copied),
        this.state.offset
      );
      this.state.offset += copied;
      chunkOffset += copied;

      if (this.state.offset !== this.state.bytes.byteLength) {
        continue;
      }

      if (this.state._tag === "prefix") {
        const started = this.startFrame();
        if (Result.isFailure(started)) {
          return Result.fail(started.failure);
        }
        continue;
      }

      frames += 1;
      if (frames > limits.maxFramesPerPush) {
        return this.fail(
          limitExceeded("frames-per-push", limits.maxFramesPerPush, frames)
        );
      }
      const decoded = decodeFrameBody(this.state.bytes);
      if (Result.isFailure(decoded)) {
        return this.fail(decoded.failure);
      }
      const consumed = consume(decoded.success);
      if (Result.isFailure(consumed)) {
        return this.fail(consumed.failure);
      }
      if (consumed.success.emit) {
        events.push(consumed.success.value);
      }
      this.state = {
        _tag: "prefix",
        bytes: new Uint8Array(lengthPrefixBytes),
        offset: 0,
      };
    }

    return Result.succeed(events);
  }

  private startFrame(): Result.Result<void, WireDecodeError> {
    if (this.state._tag !== "prefix") {
      return Result.succeed(undefined);
    }
    const declaredBytes = readUint32(this.state.bytes);
    if (declaredBytes < lengthPrefixBytes) {
      return this.fail(
        malformed("length", "Frame declares an invalid body length.")
      );
    }
    if (declaredBytes > maximumFrameBytes) {
      return this.fail(
        new FrameTooLargeError({
          declaredBytes,
          maximumBytes: maximumFrameBytes,
          message: "Frame exceeds the maximum size.",
        })
      );
    }
    this.state = {
      _tag: "frame",
      bytes: new Uint8Array(declaredBytes),
      offset: 0,
    };
    return Result.succeed(undefined);
  }

  private fail<A>(error: WireDecodeError): Result.Result<A, WireDecodeError> {
    this.state = { _tag: "failed", error };
    return Result.fail(error);
  }
}

const makeSession = <A>(
  limits: WireSessionLimits,
  consume: (frame: RawFrame) => Result.Result<SessionEvent<A>, WireDecodeError>,
  complete: () => boolean
): WireSession<A> => {
  const reader = new IncrementalFrameReader();
  let sessionError: WireDecodeError | undefined;
  return {
    finish: () => {
      if (sessionError !== undefined) {
        return Result.fail(sessionError);
      }
      const finished = reader.finish();
      if (Result.isFailure(finished)) {
        sessionError = finished.failure;
        return Result.fail(finished.failure);
      }
      if (!complete()) {
        sessionError = new IncompleteSessionError({
          message: "Wire stream ended before the protocol session completed.",
        });
        return Result.fail(sessionError);
      }
      return Result.succeed(undefined);
    },
    push: (chunk) => {
      if (sessionError !== undefined) {
        return Result.fail(sessionError);
      }
      return reader.push(chunk, limits, consume);
    },
  };
};

export const makeRequestSession = (
  expectedCapability: Capability,
  overrides: Partial<WireSessionLimits> = {}
): Result.Result<RequestSession, InvalidWireLimitError> => {
  const resolved = resolveLimits(overrides);
  if (Result.isFailure(resolved)) {
    return Result.fail(resolved.failure);
  }
  const limits = resolved.success;
  let state: "auth" | "request" | "complete" = "auth";
  const authenticate = (
    frame: RawFrame
  ): Result.Result<SessionEvent<BridgeRequest>, WireDecodeError> => {
    if (frame.header.type !== "auth") {
      return Result.fail(
        illegal("order", "Request session must start with authentication.")
      );
    }
    if (frame.payload.byteLength !== 0) {
      return Result.fail(
        illegal("payload", "Authentication frame payload must be empty.")
      );
    }
    const received = parseCapability(frame.header.capability);
    if (
      Result.isFailure(received) ||
      !capabilitiesEqual(expectedCapability, received.success)
    ) {
      return Result.fail(
        new AuthenticationError({
          message: "Bridge authentication failed.",
        })
      );
    }
    state = "request";
    return Result.succeed(noEvent);
  };

  const acceptRequest = (
    frame: RawFrame
  ): Result.Result<SessionEvent<BridgeRequest>, WireDecodeError> => {
    if (frame.payload.byteLength !== 0) {
      return Result.fail(
        illegal("payload", "Request frame payload must be empty.")
      );
    }
    if (frame.header.type === "run") {
      state = "complete";
      return Result.succeed(emit({ script: frame.header.script, type: "run" }));
    }
    if (frame.header.type === "pull") {
      if (!canonicalPath(frame.header.remotePath)) {
        return Result.fail(
          illegal("path", "Pull path must be canonical and relative.")
        );
      }
      state = "complete";
      return Result.succeed(
        emit({ remotePath: frame.header.remotePath, type: "pull" })
      );
    }
    return Result.fail(
      illegal("order", "Request session contains an unexpected frame.")
    );
  };

  const consume = (
    frame: RawFrame
  ): Result.Result<SessionEvent<BridgeRequest>, WireDecodeError> => {
    if (state === "auth") {
      return authenticate(frame);
    }
    if (state === "request") {
      return acceptRequest(frame);
    }
    return Result.fail(
      illegal("order", "Request session contains an unexpected frame.")
    );
  };

  const session = makeSession<BridgeRequest>(
    limits,
    consume,
    () => state === "complete"
  );
  return Result.succeed(session);
};

export const makeRunResponseSession = (
  overrides: Partial<WireSessionLimits> = {}
): Result.Result<RunResponseSession, InvalidWireLimitError> => {
  const resolved = resolveLimits(overrides);
  if (Result.isFailure(resolved)) {
    return Result.fail(resolved.failure);
  }
  const limits = resolved.success;
  let state: "stdout" | "stderr" | "complete" = "stdout";
  let outputBytes = 0;
  const session = makeSession<RunResponseEvent>(
    limits,
    (frame) => {
      if (frame.header.type === "stdout" && state === "stdout") {
        outputBytes += frame.payload.byteLength;
        if (outputBytes > limits.maxOutputBytes) {
          return Result.fail(
            limitExceeded("output-bytes", limits.maxOutputBytes, outputBytes)
          );
        }
        return Result.succeed(emit({ payload: frame.payload, type: "stdout" }));
      }
      if (
        frame.header.type === "stderr" &&
        (state === "stdout" || state === "stderr")
      ) {
        state = "stderr";
        outputBytes += frame.payload.byteLength;
        if (outputBytes > limits.maxOutputBytes) {
          return Result.fail(
            limitExceeded("output-bytes", limits.maxOutputBytes, outputBytes)
          );
        }
        return Result.succeed(emit({ payload: frame.payload, type: "stderr" }));
      }
      if (
        frame.header.type === "exit" &&
        (state === "stdout" || state === "stderr")
      ) {
        if (frame.payload.byteLength !== 0) {
          return Result.fail(
            illegal("payload", "Exit frame payload must be empty.")
          );
        }
        state = "complete";
        return Result.succeed(
          emit({
            code: frame.header.code,
            truncated: frame.header.truncated,
            type: "exit",
          })
        );
      }
      return Result.fail(
        illegal("order", "Run response contains an unexpected frame.")
      );
    },
    () => state === "complete"
  );
  return Result.succeed(session);
};

export const makePullResponseSession = (
  overrides: Partial<WireSessionLimits> = {}
): Result.Result<PullResponseSession, InvalidWireLimitError> => {
  const resolved = resolveLimits(overrides);
  if (Result.isFailure(resolved)) {
    return Result.fail(resolved.failure);
  }
  const limits = resolved.success;

  interface CurrentFile {
    readonly entry: WirePullFileEntry;
    received: number;
  }

  let state: "manifest" | "between-files" | "file" | "complete" = "manifest";
  let manifest: WirePullManifest | undefined;
  let files: readonly WirePullFileEntry[] = [];
  let nextFileIndex = 0;
  let currentFile: CurrentFile | undefined;
  let transferredBytes = 0;

  type PullConsumeResult = Result.Result<
    SessionEvent<PullResponseEvent>,
    WireDecodeError
  >;

  const acceptManifest = (frame: RawFrame): PullConsumeResult => {
    if (frame.header.type !== "manifest") {
      return Result.fail(
        illegal("order", "Pull response must start with a manifest.")
      );
    }
    if (frame.payload.byteLength !== 0) {
      return Result.fail(
        illegal("payload", "Manifest frame payload must be empty.")
      );
    }
    const validated = validateManifest(frame.header.manifest, limits);
    if (Result.isFailure(validated)) {
      return Result.fail(validated.failure);
    }
    const { files: manifestFiles, manifest: decodedManifest } =
      validated.success;
    manifest = decodedManifest;
    files = manifestFiles;
    state = "between-files";
    return Result.succeed(
      emit({ manifest: decodedManifest, type: "manifest" })
    );
  };

  const acceptBetweenFiles = (frame: RawFrame): PullConsumeResult => {
    if (frame.header.type === "file-start") {
      if (frame.payload.byteLength !== 0) {
        return Result.fail(
          illegal("payload", "File start frame payload must be empty.")
        );
      }
      const expected = files[nextFileIndex];
      if (
        expected === undefined ||
        frame.header.path !== expected.path ||
        frame.header.size !== expected.size
      ) {
        return Result.fail(
          illegal("order", "File start does not match manifest order.")
        );
      }
      currentFile = { entry: expected, received: 0 };
      state = "file";
      return Result.succeed(
        emit({
          path: frame.header.path,
          size: frame.header.size,
          type: "file-start",
        })
      );
    }
    if (frame.header.type === "complete") {
      if (frame.payload.byteLength !== 0) {
        return Result.fail(
          illegal("payload", "Complete frame payload must be empty.")
        );
      }
      if (
        nextFileIndex !== files.length ||
        manifest === undefined ||
        transferredBytes !== manifest.totalBytes
      ) {
        return Result.fail(
          illegal("order", "Pull response completed before all files.")
        );
      }
      state = "complete";
      return Result.succeed(emit({ type: "complete" }));
    }
    return Result.fail(
      illegal("order", "Pull response contains an unexpected frame.")
    );
  };

  const acceptFileChunk = (
    offset: number,
    payload: Uint8Array,
    file: CurrentFile
  ): PullConsumeResult => {
    if (payload.byteLength === 0) {
      return Result.fail(
        illegal("payload", "File chunk payload must not be empty.")
      );
    }
    if (offset !== file.received) {
      return Result.fail(
        illegal("offset", "File chunk offset is not contiguous.")
      );
    }
    const fileBytes = file.received + payload.byteLength;
    if (fileBytes > file.entry.size) {
      return Result.fail(
        illegal("offset", "File chunks exceed the declared file size.")
      );
    }
    const transferBytes = transferredBytes + payload.byteLength;
    if (transferBytes > limits.maxTransferBytes) {
      return Result.fail(
        limitExceeded("transfer-bytes", limits.maxTransferBytes, transferBytes)
      );
    }
    file.received = fileBytes;
    transferredBytes = transferBytes;
    return Result.succeed(emit({ offset, payload, type: "file-chunk" }));
  };

  const acceptFileEnd = (
    digest: string,
    payload: Uint8Array,
    file: CurrentFile
  ): PullConsumeResult => {
    if (payload.byteLength !== 0) {
      return Result.fail(
        illegal("payload", "File end frame payload must be empty.")
      );
    }
    if (file.received !== file.entry.size || digest !== file.entry.digest) {
      return Result.fail(
        illegal("manifest", "File end does not match the manifest.")
      );
    }
    currentFile = undefined;
    nextFileIndex += 1;
    state = "between-files";
    return Result.succeed(emit({ digest, type: "file-end" }));
  };

  const acceptFile = (frame: RawFrame): PullConsumeResult => {
    const file = currentFile;
    if (file === undefined) {
      return Result.fail(
        illegal("order", "Pull response contains an unexpected frame.")
      );
    }
    if (frame.header.type === "file-chunk") {
      return acceptFileChunk(frame.header.offset, frame.payload, file);
    }
    if (frame.header.type === "file-end") {
      return acceptFileEnd(frame.header.digest, frame.payload, file);
    }
    return Result.fail(
      illegal("order", "Pull response contains an unexpected frame.")
    );
  };

  const consume = (frame: RawFrame): PullConsumeResult => {
    switch (state) {
      case "manifest":
        return acceptManifest(frame);
      case "between-files":
        return acceptBetweenFiles(frame);
      case "file":
        return acceptFile(frame);
      case "complete":
        return Result.fail(
          illegal("order", "Pull response contains an unexpected frame.")
        );
      default:
        return Result.fail(
          illegal("order", "Pull response contains an unexpected frame.")
        );
    }
  };

  const session = makeSession<PullResponseEvent>(
    limits,
    consume,
    () => state === "complete"
  );
  return Result.succeed(session);
};
