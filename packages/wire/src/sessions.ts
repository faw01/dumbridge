import {
  type Capability,
  capabilitiesEqual,
  parseCapability,
} from "@dumbridge/bridge-key";
import { Result } from "effect";
import { decodeAuthenticatedRequestFrame, decodeFrameBody } from "./codec";
import {
  AuthenticationError,
  type InvalidWireLimitError,
  illegal,
  limitExceeded,
  resolveLimits,
  type WireDecodeError,
  type WireSessionLimits,
} from "./errors";
import { canonicalPath, validateManifest } from "./manifest";
import type {
  BridgeRequest,
  PullResponseEvent,
  RawFrame,
  RunResponseEvent,
  WirePullFileEntry,
  WirePullManifest,
} from "./protocol";
import {
  emit,
  makeSession,
  noEvent,
  type SessionEvent,
  type WireSession,
} from "./reader";

export type RequestSession = WireSession<BridgeRequest>;
export type RunResponseSession = WireSession<RunResponseEvent>;
export type PullResponseSession = WireSession<PullResponseEvent>;

export const makeRequestSession = (
  expectedCapability: Capability,
  overrides: Partial<WireSessionLimits> = {}
): Result.Result<RequestSession, InvalidWireLimitError> => {
  const resolved = resolveLimits(overrides);
  if (Result.isFailure(resolved)) {
    return Result.fail(resolved.failure);
  }
  const limits = resolved.success;
  const expectedCapabilitySnapshot = Uint8Array.from(expectedCapability);
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
      !capabilitiesEqual(expectedCapabilitySnapshot, received.success)
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
    (body) => decodeAuthenticatedRequestFrame(body, state),
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
  const acceptOutput = (
    payload: Uint8Array,
    type: "stdout" | "stderr"
  ): Result.Result<SessionEvent<RunResponseEvent>, WireDecodeError> => {
    if (payload.byteLength === 0) {
      return Result.fail(
        illegal("payload", "Run output payload must not be empty.")
      );
    }
    outputBytes += payload.byteLength;
    if (outputBytes > limits.maxOutputBytes) {
      return Result.fail(
        limitExceeded("output-bytes", limits.maxOutputBytes, outputBytes)
      );
    }
    return Result.succeed(emit({ payload, type }));
  };
  const session = makeSession<RunResponseEvent>(
    limits,
    decodeFrameBody,
    (frame) => {
      if (frame.header.type === "stdout" && state === "stdout") {
        return acceptOutput(frame.payload, "stdout");
      }
      if (
        frame.header.type === "stderr" &&
        (state === "stdout" || state === "stderr")
      ) {
        state = "stderr";
        return acceptOutput(frame.payload, "stderr");
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

  const acceptFailure = (frame: RawFrame): PullConsumeResult => {
    if (frame.header.type !== "pull-error" || state === "complete") {
      return Result.fail(
        illegal("order", "Pull response contains an unexpected frame.")
      );
    }
    if (frame.payload.byteLength !== 0) {
      return Result.fail(
        illegal("payload", "Pull error frame payload must be empty.")
      );
    }
    state = "complete";
    return Result.succeed(
      emit({ code: frame.header.code, type: "pull-error" })
    );
  };

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
    if (frame.header.type === "pull-error") {
      return acceptFailure(frame);
    }
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
    decodeFrameBody,
    consume,
    () => state === "complete"
  );
  return Result.succeed(session);
};
