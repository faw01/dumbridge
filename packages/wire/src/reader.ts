import { Result } from "effect";
import type { FrameDecoder } from "./codec";
import { readUint32 } from "./codec";
import {
  FrameTooLargeError,
  IncompleteFrameError,
  IncompleteSessionError,
  limitExceeded,
  malformed,
  type WireDecodeError,
  type WireSessionLimits,
} from "./errors";
import {
  lengthPrefixBytes,
  maximumFrameBytes,
  type RawFrame,
} from "./protocol";

export type SessionEvent<A> =
  | { readonly emit: false }
  | { readonly emit: true; readonly value: A };

export const noEvent: SessionEvent<never> = { emit: false };
export const emit = <A>(value: A): SessionEvent<A> => ({ emit: true, value });

export interface WireSession<A> {
  readonly finish: () => Result.Result<void, WireDecodeError>;
  readonly push: (
    chunk: Uint8Array
  ) => Result.Result<readonly A[], WireDecodeError>;
}

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
  private frameCount = 0;
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
    decode: FrameDecoder,
    consume: (
      frame: RawFrame
    ) => Result.Result<SessionEvent<A>, WireDecodeError>
  ): Result.Result<readonly A[], WireDecodeError> {
    if (this.state._tag === "failed") {
      return Result.fail(this.state.error);
    }

    const events: A[] = [];
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
        const started = this.startFrame();
        if (Result.isFailure(started)) {
          return Result.fail(started.failure);
        }
        continue;
      }

      const consumed = this.finishFrame(
        this.state.bytes,
        limits,
        decode,
        consume
      );
      if (Result.isFailure(consumed)) {
        return Result.fail(consumed.failure);
      }
      if (consumed.success.emit) {
        events.push(consumed.success.value);
      }
    }

    return Result.succeed(events);
  }

  // One completed frame body: charge it against the session frame budget,
  // decode it, hand it to the protocol state machine, then rearm for the
  // next length prefix.
  private finishFrame<A>(
    body: Uint8Array,
    limits: WireSessionLimits,
    decode: FrameDecoder,
    consume: (
      frame: RawFrame
    ) => Result.Result<SessionEvent<A>, WireDecodeError>
  ): Result.Result<SessionEvent<A>, WireDecodeError> {
    this.frameCount += 1;
    if (this.frameCount > limits.maxFramesPerSession) {
      return this.fail(
        limitExceeded(
          "frames-per-session",
          limits.maxFramesPerSession,
          this.frameCount
        )
      );
    }
    const decoded = decode(body);
    if (Result.isFailure(decoded)) {
      return this.fail(decoded.failure);
    }
    const consumed = consume(decoded.success);
    if (Result.isFailure(consumed)) {
      return this.fail(consumed.failure);
    }
    this.state = {
      _tag: "prefix",
      bytes: new Uint8Array(lengthPrefixBytes),
      offset: 0,
    };
    return consumed;
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

export const makeSession = <A>(
  limits: WireSessionLimits,
  decode: FrameDecoder,
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
      return reader.push(chunk, limits, decode, consume);
    },
  };
};
