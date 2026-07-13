import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import { encodeCapability, makeCapability } from "../src/bridge/link";
import {
  encodeFrame,
  makePullResponseSession,
  makeRequestSession,
  makeRunResponseSession,
  type WireFrame,
  type WirePullManifest,
} from "../src/bridge/wire";

const digest = "a".repeat(64);
const capabilityBytes = Uint8Array.from({ length: 32 }, (_, index) => index);
const otherCapabilityBytes = Uint8Array.from(capabilityBytes, (byte, index) =>
  index === 31 ? (byte + 1) % 256 : byte
);

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) {
    throw result.failure;
  }
  return result.success;
};

const capability = success(makeCapability(capabilityBytes));
const otherCapability = success(makeCapability(otherCapabilityBytes));

const encoded = (frame: WireFrame) => success(encodeFrame(frame));

const joinChunks = (...chunks: readonly Uint8Array[]) => {
  const byteLength = chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0
  );
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
};

const rawFrameFromText = (
  headerText: string,
  payload: Uint8Array = new Uint8Array()
) => {
  const header = new TextEncoder().encode(headerText);
  const bodyLength = 4 + header.byteLength + payload.byteLength;
  const frame = new Uint8Array(4 + bodyLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, bodyLength, false);
  view.setUint32(4, header.byteLength, false);
  frame.set(header, 8);
  frame.set(payload, 8 + header.byteLength);
  return frame;
};

const rawFrame = (header: object, payload: Uint8Array = new Uint8Array()) =>
  rawFrameFromText(JSON.stringify(header), payload);

const manifest = {
  digestAlgorithm: "sha256",
  entries: [
    { kind: "directory", path: "assets" },
    {
      digest,
      kind: "file",
      path: "assets/a.txt",
      size: 3,
    },
  ],
  kind: "directory",
  name: "bundle",
  totalBytes: 3,
} satisfies WirePullManifest;

describe("request session", () => {
  test("authenticates before parsing a coalesced request", () => {
    const session = success(makeRequestSession(capability));
    const pushed = session.push(
      joinChunks(
        encoded({ capability, type: "auth" }),
        encoded({ script: "find .", type: "run" })
      )
    );

    expect(Result.isSuccess(pushed)).toBe(true);
    if (Result.isSuccess(pushed)) {
      expect(pushed.success).toEqual([{ script: "find .", type: "run" }]);
    }
    expect(Result.isSuccess(session.finish())).toBe(true);
  });

  test("stops at failed authentication before parsing trailing bytes", () => {
    const session = success(makeRequestSession(capability));
    const pushed = session.push(
      joinChunks(
        encoded({ capability: otherCapability, type: "auth" }),
        rawFrameFromText("{")
      )
    );

    expect(Result.isFailure(pushed)).toBe(true);
    if (Result.isFailure(pushed)) {
      expect(pushed.failure._tag).toBe("AuthenticationError");
      expect(JSON.stringify(pushed.failure)).not.toContain(
        success(encodeCapability(otherCapability))
      );
    }
  });

  test("rejects unauthenticated, duplicate, and payload-bearing requests", () => {
    const unauthenticated = success(makeRequestSession(capability));
    const withoutAuth = unauthenticated.push(
      encoded({ remotePath: ".agents", type: "pull" })
    );
    expect(Result.isFailure(withoutAuth)).toBe(true);
    if (Result.isFailure(withoutAuth)) {
      expect(withoutAuth.failure._tag).toBe("IllegalFrameError");
    }

    const duplicate = success(makeRequestSession(capability));
    const duplicateRequest = duplicate.push(
      joinChunks(
        encoded({ capability, type: "auth" }),
        encoded({ script: "find .", type: "run" }),
        encoded({ remotePath: ".agents", type: "pull" })
      )
    );
    expect(Result.isFailure(duplicateRequest)).toBe(true);
    if (Result.isFailure(duplicateRequest)) {
      expect(duplicateRequest.failure._tag).toBe("IllegalFrameError");
    }

    const payloadBearing = success(makeRequestSession(capability));
    const capabilityText = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const authPayload = payloadBearing.push(
      rawFrame(
        {
          capability: capabilityText,
          protocol: "dumbridge/1",
          type: "auth",
        },
        Uint8Array.of(1)
      )
    );
    expect(Result.isFailure(authPayload)).toBe(true);
    if (Result.isFailure(authPayload)) {
      expect(authPayload.failure).toMatchObject({
        _tag: "IllegalFrameError",
        reason: "payload",
      });
    }
  });

  test("never retains untrusted protocol or type strings in errors", () => {
    const secret = "dumbridge1_SECRET_BEARER";
    const protocolSession = success(makeRequestSession(capability));
    const unsupported = protocolSession.push(
      rawFrame({ protocol: secret, type: "auth" })
    );
    expect(Result.isFailure(unsupported)).toBe(true);
    if (Result.isFailure(unsupported)) {
      expect(unsupported.failure._tag).toBe("UnsupportedProtocolError");
      expect(JSON.stringify(unsupported.failure)).not.toContain(secret);
    }

    const typeSession = success(makeRequestSession(capability));
    const unknown = typeSession.push(
      rawFrame({ protocol: "dumbridge/1", type: secret })
    );
    expect(Result.isFailure(unknown)).toBe(true);
    if (Result.isFailure(unknown)) {
      expect(unknown.failure._tag).toBe("UnknownFrameTypeError");
      expect(JSON.stringify(unknown.failure)).not.toContain(secret);
    }
  });
});

describe("run response session", () => {
  test("accepts bounded stdout then stderr and exactly one exit", () => {
    const session = success(makeRunResponseSession());
    const stdout = Uint8Array.from([0, 255, 1]);
    const stderr = new TextEncoder().encode("warning");
    const pushed = session.push(
      joinChunks(
        encoded({ payload: stdout, type: "stdout" }),
        encoded({ payload: stderr, type: "stderr" }),
        encoded({ code: 0, truncated: false, type: "exit" })
      )
    );

    expect(Result.isSuccess(pushed)).toBe(true);
    if (Result.isSuccess(pushed)) {
      expect(pushed.success).toHaveLength(3);
      const [stdoutEvent, stderrEvent] = pushed.success;
      expect(stdoutEvent?.type).toBe("stdout");
      expect(stderrEvent?.type).toBe("stderr");
      if (stdoutEvent?.type === "stdout" && stderrEvent?.type === "stderr") {
        expect([...stdoutEvent.payload]).toEqual([...stdout]);
        expect([...stderrEvent.payload]).toEqual([...stderr]);
      }
      expect(pushed.success[2]).toEqual({
        code: 0,
        truncated: false,
        type: "exit",
      });
    }
    expect(Result.isSuccess(session.finish())).toBe(true);
  });

  test("rejects output order, exit payloads, and missing exit", () => {
    const outOfOrder = success(makeRunResponseSession());
    const orderResult = outOfOrder.push(
      joinChunks(
        encoded({ payload: Uint8Array.of(1), type: "stderr" }),
        encoded({ payload: Uint8Array.of(2), type: "stdout" })
      )
    );
    expect(Result.isFailure(orderResult)).toBe(true);
    if (Result.isFailure(orderResult)) {
      expect(orderResult.failure).toMatchObject({
        _tag: "IllegalFrameError",
        reason: "order",
      });
    }

    const exitPayload = success(makeRunResponseSession());
    const payloadResult = exitPayload.push(
      rawFrame(
        {
          code: 0,
          protocol: "dumbridge/1",
          truncated: false,
          type: "exit",
        },
        Uint8Array.of(1)
      )
    );
    expect(Result.isFailure(payloadResult)).toBe(true);
    if (Result.isFailure(payloadResult)) {
      expect(payloadResult.failure).toMatchObject({
        _tag: "IllegalFrameError",
        reason: "payload",
      });
    }

    const incomplete = success(makeRunResponseSession());
    success(
      incomplete.push(encoded({ payload: new Uint8Array(), type: "stdout" }))
    );
    const finished = incomplete.finish();
    expect(Result.isFailure(finished)).toBe(true);
    if (Result.isFailure(finished)) {
      expect(finished.failure._tag).toBe("IncompleteSessionError");
    }
  });

  test("enforces aggregate output and per-push frame limits", () => {
    const outputLimited = success(
      makeRunResponseSession({ maxOutputBytes: 4 })
    );
    const output = outputLimited.push(
      encoded({ payload: new Uint8Array(5), type: "stdout" })
    );
    expect(Result.isFailure(output)).toBe(true);
    if (Result.isFailure(output)) {
      expect(output.failure).toMatchObject({
        _tag: "WireLimitExceededError",
        limit: "output-bytes",
      });
    }

    const frameLimited = success(
      makeRunResponseSession({ maxFramesPerPush: 2 })
    );
    const frames = frameLimited.push(
      joinChunks(
        encoded({ payload: new Uint8Array(), type: "stdout" }),
        encoded({ payload: new Uint8Array(), type: "stdout" }),
        encoded({ payload: new Uint8Array(), type: "stdout" })
      )
    );
    expect(Result.isFailure(frames)).toBe(true);
    if (Result.isFailure(frames)) {
      expect(frames.failure).toMatchObject({
        _tag: "WireLimitExceededError",
        limit: "frames-per-push",
      });
    }

    const inputLimited = success(makeRunResponseSession({ maxInputBytes: 8 }));
    const input = inputLimited.push(new Uint8Array(9));
    expect(Result.isFailure(input)).toBe(true);
    if (Result.isFailure(input)) {
      expect(input.failure).toMatchObject({
        _tag: "WireLimitExceededError",
        limit: "input-bytes",
      });
    }
  });
});

describe("pull response session", () => {
  test("round trips a lossless manifest and ordered file stream", () => {
    const firstChunk = Uint8Array.from([0, 255]);
    const secondChunk = Uint8Array.of(1);
    const session = success(makePullResponseSession());
    const pushed = session.push(
      joinChunks(
        encoded({ manifest, type: "manifest" }),
        encoded({ path: "assets/a.txt", size: 3, type: "file-start" }),
        encoded({ offset: 0, payload: firstChunk, type: "file-chunk" }),
        encoded({ offset: 2, payload: secondChunk, type: "file-chunk" }),
        encoded({ digest, type: "file-end" }),
        encoded({ type: "complete" })
      )
    );

    expect(Result.isSuccess(pushed)).toBe(true);
    if (Result.isSuccess(pushed)) {
      expect(pushed.success[0]).toEqual({ manifest, type: "manifest" });
      expect(pushed.success[1]).toEqual({
        path: "assets/a.txt",
        size: 3,
        type: "file-start",
      });
      const [, , firstChunkEvent, secondChunkEvent] = pushed.success;
      expect(firstChunkEvent?.type).toBe("file-chunk");
      expect(secondChunkEvent?.type).toBe("file-chunk");
      if (
        firstChunkEvent?.type === "file-chunk" &&
        secondChunkEvent?.type === "file-chunk"
      ) {
        expect([...firstChunkEvent.payload]).toEqual([...firstChunk]);
        expect([...secondChunkEvent.payload]).toEqual([...secondChunk]);
      }
      expect(pushed.success[4]).toEqual({ digest, type: "file-end" });
      expect(pushed.success[5]).toEqual({ type: "complete" });
    }
    expect(Result.isSuccess(session.finish())).toBe(true);
  });

  test("rejects out-of-order files and incorrect chunk offsets", () => {
    const incompleteTransfer = success(makePullResponseSession());
    const earlyComplete = incompleteTransfer.push(
      joinChunks(
        encoded({ manifest, type: "manifest" }),
        encoded({ type: "complete" })
      )
    );
    expect(Result.isFailure(earlyComplete)).toBe(true);
    if (Result.isFailure(earlyComplete)) {
      expect(earlyComplete.failure).toMatchObject({
        _tag: "IllegalFrameError",
        reason: "order",
      });
    }

    const badOffset = success(makePullResponseSession());
    const offsetResult = badOffset.push(
      joinChunks(
        encoded({ manifest, type: "manifest" }),
        encoded({ path: "assets/a.txt", size: 3, type: "file-start" }),
        encoded({ offset: 1, payload: Uint8Array.of(1), type: "file-chunk" })
      )
    );
    expect(Result.isFailure(offsetResult)).toBe(true);
    if (Result.isFailure(offsetResult)) {
      expect(offsetResult.failure).toMatchObject({
        _tag: "IllegalFrameError",
        reason: "offset",
      });
    }
  });

  test("rejects a file digest that differs from its manifest", () => {
    const session = success(makePullResponseSession());
    const result = session.push(
      joinChunks(
        encoded({ manifest, type: "manifest" }),
        encoded({ path: "assets/a.txt", size: 3, type: "file-start" }),
        encoded({
          offset: 0,
          payload: Uint8Array.of(1, 2, 3),
          type: "file-chunk",
        }),
        encoded({ digest: "b".repeat(64), type: "file-end" })
      )
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "IllegalFrameError",
        reason: "manifest",
      });
    }
  });

  test("rejects payloads on control frames", () => {
    const session = success(makePullResponseSession());
    success(session.push(encoded({ manifest, type: "manifest" })));
    const result = session.push(
      rawFrame(
        {
          path: "assets/a.txt",
          protocol: "dumbridge/1",
          size: 3,
          type: "file-start",
        },
        Uint8Array.of(1)
      )
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "IllegalFrameError",
        reason: "payload",
      });
    }
  });

  test("enforces manifest entry and aggregate transfer limits", () => {
    const entryLimited = success(
      makePullResponseSession({ maxManifestEntries: 1 })
    );
    const entries = entryLimited.push(encoded({ manifest, type: "manifest" }));
    expect(Result.isFailure(entries)).toBe(true);
    if (Result.isFailure(entries)) {
      expect(entries.failure).toMatchObject({
        _tag: "WireLimitExceededError",
        limit: "manifest-entries",
      });
    }

    const transferLimited = success(
      makePullResponseSession({ maxTransferBytes: 2 })
    );
    const transfer = transferLimited.push(
      encoded({ manifest, type: "manifest" })
    );
    expect(Result.isFailure(transfer)).toBe(true);
    if (Result.isFailure(transfer)) {
      expect(transfer.failure).toMatchObject({
        _tag: "WireLimitExceededError",
        limit: "transfer-bytes",
      });
    }
  });

  test("rejects inconsistent manifest totals at both encode and decode seams", () => {
    const inconsistent = { ...manifest, totalBytes: 4 };
    const encoding = encodeFrame({ manifest: inconsistent, type: "manifest" });
    expect(Result.isFailure(encoding)).toBe(true);
    if (Result.isFailure(encoding)) {
      expect(encoding.failure).toMatchObject({
        _tag: "IllegalFrameError",
        reason: "manifest",
      });
    }

    const session = success(makePullResponseSession());
    const decoding = session.push(
      rawFrame({
        manifest: inconsistent,
        protocol: "dumbridge/1",
        type: "manifest",
      })
    );
    expect(Result.isFailure(decoding)).toBe(true);
    if (Result.isFailure(decoding)) {
      expect(decoding.failure).toMatchObject({
        _tag: "IllegalFrameError",
        reason: "manifest",
      });
    }
  });

  test("rejects manifests that omit declared parent directories", () => {
    const missingParent = {
      ...manifest,
      entries: [
        {
          digest,
          kind: "file",
          path: "assets/a.txt",
          size: 3,
        },
      ],
    } satisfies WirePullManifest;
    const encoding = encodeFrame({ manifest: missingParent, type: "manifest" });
    expect(Result.isFailure(encoding)).toBe(true);
    if (Result.isFailure(encoding)) {
      expect(encoding.failure).toMatchObject({
        _tag: "IllegalFrameError",
        reason: "manifest",
      });
    }

    const session = success(makePullResponseSession());
    const decoding = session.push(
      rawFrame({
        manifest: missingParent,
        protocol: "dumbridge/1",
        type: "manifest",
      })
    );
    expect(Result.isFailure(decoding)).toBe(true);
    if (Result.isFailure(decoding)) {
      expect(decoding.failure).toMatchObject({
        _tag: "IllegalFrameError",
        reason: "manifest",
      });
    }
  });
});
