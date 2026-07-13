import { Result, Schema } from "effect";
import { CapabilityTextSchema } from "./link";

const protocol = "dumbridge/1" as const;
const lengthPrefixBytes = 4;
const maximumFrameBytes = 1024 * 1024;
const maximumHeaderBytes = 16 * 1024;
const maximumManifestEntries = 4096;
const maximumPathCharacters = 4096;
const maximumScriptCharacters = 8192;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Path = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maximumPathCharacters)
);

const ManifestEntrySchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("directory"),
    path: Path,
  }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: Path,
    size: NonNegativeInt,
  }),
]);

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
  entries: Schema.Array(ManifestEntrySchema).check(
    Schema.isMaxLength(maximumManifestEntries)
  ),
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
  digest: Schema.String.check(
    Schema.isLengthBetween(64, 64),
    Schema.isPattern(/^[a-f0-9]{64}$/)
  ),
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("file-end"),
});

const CompleteHeaderSchema = Schema.Struct({
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("complete"),
});

export const RequestHeaderSchema = Schema.Union([
  AuthHeaderSchema,
  RunHeaderSchema,
  PullHeaderSchema,
]);

export const ResponseHeaderSchema = Schema.Union([
  StdoutHeaderSchema,
  StderrHeaderSchema,
  ExitHeaderSchema,
  ManifestHeaderSchema,
  FileStartHeaderSchema,
  FileChunkHeaderSchema,
  FileEndHeaderSchema,
  CompleteHeaderSchema,
]);

export const WireHeaderSchema = Schema.Union([
  RequestHeaderSchema,
  ResponseHeaderSchema,
]);
const WireHeaderJson = Schema.fromJsonString(WireHeaderSchema);
const HeaderEnvelopeSchema = Schema.Struct({
  protocol: Schema.String,
  type: Schema.String,
});
const knownHeaderTypes = new Set([
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
]);

export type WireHeader = typeof WireHeaderSchema.Type;

export interface WireFrame {
  readonly header: WireHeader;
  readonly payload: Uint8Array;
}

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
  {
    message: Schema.String,
    receivedProtocol: Schema.String,
  }
) {}

export class UnknownFrameTypeError extends Schema.TaggedErrorClass<UnknownFrameTypeError>()(
  "UnknownFrameTypeError",
  {
    message: Schema.String,
    receivedType: Schema.String,
  }
) {}

export type WireEncodeError = FrameTooLargeError | MalformedFrameError;
export type WireDecodeError =
  | WireEncodeError
  | IncompleteFrameError
  | UnsupportedProtocolError
  | UnknownFrameTypeError;

export interface FrameDecoder {
  readonly finish: () => Result.Result<void, WireDecodeError>;
  readonly push: (
    chunk: Uint8Array
  ) => Result.Result<readonly WireFrame[], WireDecodeError>;
}

const malformed = (reason: MalformedFrameError["reason"], message: string) =>
  new MalformedFrameError({ message, reason });

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

export const encodeFrame = (
  frame: WireFrame
): Result.Result<Uint8Array, WireEncodeError> => {
  const headerJson = Schema.encodeResult(WireHeaderJson)(frame.header);
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

const decodeFrameBody = (
  body: Uint8Array
): Result.Result<WireFrame, WireDecodeError> => {
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
        receivedProtocol: envelope.success.protocol,
      })
    );
  }
  if (!knownHeaderTypes.has(envelope.success.type)) {
    return Result.fail(
      new UnknownFrameTypeError({
        message: "Frame uses an unknown header type.",
        receivedType: envelope.success.type,
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

type DecoderState =
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

class IncrementalFrameDecoder implements FrameDecoder {
  private state: DecoderState = {
    _tag: "prefix",
    bytes: new Uint8Array(lengthPrefixBytes),
    offset: 0,
  };

  readonly finish = (): Result.Result<void, WireDecodeError> => {
    if (this.state._tag === "failed") {
      return Result.fail(this.state.error);
    }
    if (this.state._tag === "prefix" && this.state.offset === 0) {
      return Result.succeed(undefined);
    }
    const receivedBytes = this.state.offset;
    const error = new IncompleteFrameError({
      message: "Wire stream ended with an incomplete frame.",
      receivedBytes,
    });
    this.state = { _tag: "failed", error };
    return Result.fail(error);
  };

  readonly push = (
    chunk: Uint8Array
  ): Result.Result<readonly WireFrame[], WireDecodeError> => {
    if (this.state._tag === "failed") {
      return Result.fail(this.state.error);
    }

    const frames: WireFrame[] = [];
    let chunkOffset = 0;
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
        continue;
      }

      const decoded = decodeFrameBody(this.state.bytes);
      if (Result.isFailure(decoded)) {
        return this.fail(decoded.failure);
      }
      frames.push(decoded.success);
      this.state = {
        _tag: "prefix",
        bytes: new Uint8Array(lengthPrefixBytes),
        offset: 0,
      };
    }

    return Result.succeed(frames);
  };

  private fail(error: WireDecodeError): Result.Result<never, WireDecodeError> {
    this.state = { _tag: "failed", error };
    return Result.fail(error);
  }
}

export const makeFrameDecoder = (): FrameDecoder =>
  new IncrementalFrameDecoder();
