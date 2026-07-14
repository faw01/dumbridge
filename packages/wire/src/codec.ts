import { encodeCapability } from "@dumbridge/bridge-key";
import { parseRemotePath } from "@dumbridge/remote-path";
import { Result, Schema } from "effect";
import {
  defaultSessionLimits,
  FrameTooLargeError,
  illegal,
  limitExceeded,
  malformed,
  UnknownFrameTypeError,
  UnsupportedProtocolError,
  validateManifest,
  type WireDecodeError,
  type WireEncodeError,
} from "./errors";
import {
  AuthHeaderSchema,
  HeaderEnvelopeSchema,
  knownHeaderTypes,
  lengthPrefixBytes,
  maximumFrameBytes,
  maximumHeaderBytes,
  protocol,
  type RawFrame,
  RequestHeaderSchema,
  type WireFrame,
  type WireHeader,
  WireHeaderJson,
  WireHeaderSchema,
} from "./protocol";

export const writeUint32 = (
  target: Uint8Array,
  offset: number,
  value: number
) => {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(
    offset,
    value,
    false
  );
};

export const readUint32 = (source: Uint8Array, offset = 0) =>
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
      if (Result.isFailure(parseRemotePath(frame.remotePath))) {
        return Result.fail(
          illegal("path", "Pull path must be canonical and relative.")
        );
      }
      return Result.succeed({
        header: { protocol, remotePath: frame.remotePath, type: "pull" },
        payload: empty,
      });
    case "banner":
      return Result.succeed({
        header: { protocol, served: frame.served, type: "banner" },
        payload: empty,
      });
    case "stdout":
      if (frame.payload.byteLength === 0) {
        return Result.fail(
          illegal("payload", "Standard output payload must not be empty.")
        );
      }
      return Result.succeed({
        header: { protocol, type: "stdout" },
        payload: frame.payload,
      });
    case "stderr":
      if (frame.payload.byteLength === 0) {
        return Result.fail(
          illegal("payload", "Standard error payload must not be empty.")
        );
      }
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
      if (Result.isFailure(parseRemotePath(frame.path))) {
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
    case "pull-error":
      return Result.succeed({
        header: { code: frame.code, protocol, type: "pull-error" },
        payload: empty,
      });
    case "reject":
      return Result.succeed({
        header: { code: frame.code, protocol, type: "reject" },
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

interface UndecodedFrame {
  readonly body: Uint8Array;
  readonly headerEnd: number;
  readonly headerValue: unknown;
  readonly type: string;
}

export type FrameDecoder = (
  body: Uint8Array
) => Result.Result<RawFrame, WireDecodeError>;

const decodeFrameEnvelope = (
  body: Uint8Array
): Result.Result<UndecodedFrame, WireDecodeError> => {
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
        message: "Frame uses an unsupported dumbridge protocol.",
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

  return Result.succeed({
    body,
    headerEnd,
    headerValue: json.success,
    type: envelope.success.type,
  });
};

const makeRawFrame = (frame: UndecodedFrame, header: WireHeader): RawFrame => ({
  header,
  payload: frame.body.slice(frame.headerEnd),
});

export const decodeFrameBody: FrameDecoder = (body) => {
  const frame = decodeFrameEnvelope(body);
  if (Result.isFailure(frame)) {
    return Result.fail(frame.failure);
  }

  const header = Schema.decodeUnknownResult(WireHeaderSchema)(
    frame.success.headerValue,
    {
      onExcessProperty: "error",
    }
  );
  if (Result.isFailure(header)) {
    return Result.fail(
      malformed("schema", "Frame header does not match the wire schema.")
    );
  }

  return Result.succeed(makeRawFrame(frame.success, header.success));
};

export const decodeAuthenticatedRequestFrame = (
  body: Uint8Array,
  state: "auth" | "request" | "complete"
): Result.Result<RawFrame, WireDecodeError> => {
  const frame = decodeFrameEnvelope(body);
  if (Result.isFailure(frame)) {
    return Result.fail(frame.failure);
  }

  if (state === "auth") {
    if (frame.success.type !== "auth") {
      return Result.fail(
        illegal("order", "Request session must start with authentication.")
      );
    }
    const header = Schema.decodeUnknownResult(AuthHeaderSchema)(
      frame.success.headerValue,
      {
        onExcessProperty: "error",
      }
    );
    if (Result.isFailure(header)) {
      return Result.fail(
        malformed(
          "schema",
          "Authentication header does not match the wire schema."
        )
      );
    }
    return Result.succeed(makeRawFrame(frame.success, header.success));
  }

  if (
    state === "complete" ||
    (frame.success.type !== "run" && frame.success.type !== "pull")
  ) {
    return Result.fail(
      illegal("order", "Request session contains an unexpected frame.")
    );
  }

  const header = Schema.decodeUnknownResult(RequestHeaderSchema)(
    frame.success.headerValue,
    { onExcessProperty: "error" }
  );
  if (Result.isFailure(header)) {
    return Result.fail(
      malformed("schema", "Request header does not match the wire schema.")
    );
  }

  return Result.succeed(makeRawFrame(frame.success, header.success));
};
