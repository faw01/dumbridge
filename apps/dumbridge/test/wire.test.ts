import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import {
  encodeFrame,
  makeFrameDecoder,
  type WireFrame,
  type WireHeader,
} from "../src/bridge/wire";

const frameFromHeaderText = (headerText: string) => {
  const header = new TextEncoder().encode(headerText);
  const bodyLength = 4 + header.byteLength;
  const frame = new Uint8Array(4 + bodyLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, bodyLength, false);
  view.setUint32(4, header.byteLength, false);
  frame.set(header, 8);
  return frame;
};

const frameFromHeader = (header: object) =>
  frameFromHeaderText(JSON.stringify(header));

describe("Wire", () => {
  test("round trips raw file bytes without base64 encoding", () => {
    const payload = Uint8Array.from([0, 255, 1, 254]);
    const encoded = encodeFrame({
      header: {
        offset: 0,
        protocol: "dumbridge/1",
        type: "file-chunk",
      },
      payload,
    });
    expect(Result.isSuccess(encoded)).toBe(true);
    if (Result.isFailure(encoded)) {
      return;
    }

    expect([...encoded.success.slice(-payload.length)]).toEqual([...payload]);

    const decoder = makeFrameDecoder();
    const decoded = decoder.push(encoded.success);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      return;
    }

    expect(decoded.success).toHaveLength(1);
    expect(decoded.success[0]?.header).toEqual({
      offset: 0,
      protocol: "dumbridge/1",
      type: "file-chunk",
    });
    expect([...(decoded.success[0]?.payload ?? [])]).toEqual([...payload]);
    expect(Result.isSuccess(decoder.finish())).toBe(true);
  });

  test("decodes a frame split across arbitrary chunks", () => {
    const payload = Uint8Array.from([9, 8, 7, 6, 5]);
    const encoded = encodeFrame({
      header: {
        offset: 4096,
        protocol: "dumbridge/1",
        type: "file-chunk",
      },
      payload,
    });
    if (Result.isFailure(encoded)) {
      throw encoded.failure;
    }

    const decoder = makeFrameDecoder();
    const frames: WireFrame[] = [];
    for (const byte of encoded.success) {
      const decoded = decoder.push(Uint8Array.of(byte));
      if (Result.isFailure(decoded)) {
        throw decoded.failure;
      }
      frames.push(...decoded.success);
    }

    expect(frames).toHaveLength(1);
    expect(frames[0]?.header).toEqual({
      offset: 4096,
      protocol: "dumbridge/1",
      type: "file-chunk",
    });
    expect([...(frames[0]?.payload ?? [])]).toEqual([...payload]);
    expect(Result.isSuccess(decoder.finish())).toBe(true);
  });

  test("round trips every v1 request and response header", () => {
    const headers: readonly WireHeader[] = [
      {
        capability: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        protocol: "dumbridge/1",
        type: "auth",
      },
      { protocol: "dumbridge/1", script: "find .", type: "run" },
      {
        protocol: "dumbridge/1",
        remotePath: ".agents/skills",
        type: "pull",
      },
      { protocol: "dumbridge/1", type: "stdout" },
      { protocol: "dumbridge/1", type: "stderr" },
      { code: 0, protocol: "dumbridge/1", truncated: false, type: "exit" },
      {
        entries: [
          { kind: "directory", path: "skills" },
          { kind: "file", path: "skills/SKILL.md", size: 120 },
        ],
        protocol: "dumbridge/1",
        type: "manifest",
      },
      {
        path: "skills/SKILL.md",
        protocol: "dumbridge/1",
        size: 120,
        type: "file-start",
      },
      { offset: 0, protocol: "dumbridge/1", type: "file-chunk" },
      {
        digest:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        protocol: "dumbridge/1",
        type: "file-end",
      },
      { protocol: "dumbridge/1", type: "complete" },
    ];

    const decoder = makeFrameDecoder();
    for (const header of headers) {
      const encoded = encodeFrame({ header, payload: new Uint8Array() });
      if (Result.isFailure(encoded)) {
        throw encoded.failure;
      }
      const decoded = decoder.push(encoded.success);
      if (Result.isFailure(decoded)) {
        throw decoded.failure;
      }

      expect(decoded.success[0]?.header).toEqual(header);
    }
    expect(Result.isSuccess(decoder.finish())).toBe(true);
  });

  test("fails closed on malformed, unsupported, and unknown headers", () => {
    const cases = [
      {
        expectedTag: "MalformedFrameError",
        frame: frameFromHeaderText("{"),
      },
      {
        expectedTag: "UnsupportedProtocolError",
        frame: frameFromHeader({
          protocol: "dumbridge/2",
          type: "stdout",
        }),
      },
      {
        expectedTag: "UnknownFrameTypeError",
        frame: frameFromHeader({
          protocol: "dumbridge/1",
          type: "exec",
        }),
      },
    ] as const;

    for (const { expectedTag, frame } of cases) {
      const decoder = makeFrameDecoder();
      const failed = decoder.push(frame);
      expect(Result.isFailure(failed)).toBe(true);
      if (Result.isSuccess(failed)) {
        continue;
      }
      expect(failed.failure._tag).toBe(expectedTag);

      const retried = decoder.push(
        frameFromHeader({ protocol: "dumbridge/1", type: "complete" })
      );
      expect(Result.isFailure(retried)).toBe(true);
      if (Result.isFailure(retried)) {
        expect(retried.failure._tag).toBe(expectedTag);
      }
    }
  });

  test("rejects an oversized frame before reading its body", () => {
    const declaredLength = new Uint8Array(4);
    new DataView(declaredLength.buffer).setUint32(0, 0xff_ff_ff_ff, false);
    const decoder = makeFrameDecoder();

    const decoded = decoder.push(declaredLength);

    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect(decoded.failure._tag).toBe("FrameTooLargeError");
    }
  });

  test("rejects an invalid authentication capability without echoing it", () => {
    const capability = "too-short-and-secret";
    const decoder = makeFrameDecoder();

    const decoded = decoder.push(
      frameFromHeader({ capability, protocol: "dumbridge/1", type: "auth" })
    );

    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect(decoded.failure._tag).toBe("MalformedFrameError");
      expect(decoded.failure.message).not.toContain(capability);
    }
  });

  test("rejects a stream that ends between frame chunks", () => {
    const decoder = makeFrameDecoder();
    expect(Result.isSuccess(decoder.push(Uint8Array.of(0, 0)))).toBe(true);

    const finished = decoder.finish();

    expect(Result.isFailure(finished)).toBe(true);
    if (Result.isFailure(finished)) {
      expect(finished.failure._tag).toBe("IncompleteFrameError");
    }
  });
});
