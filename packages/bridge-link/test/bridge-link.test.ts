import { describe, expect, test } from "bun:test";
import {
  capabilitiesEqual,
  encodeBridgeLink,
  makeCapability,
  mintCapability,
  parseBridgeLink,
  redactBridgeLink,
} from "@dumbridge/bridge-link";
import { Result } from "effect";

const capabilityBytes = Uint8Array.from({ length: 32 }, (_, index) => index);

describe("BridgeLink", () => {
  test("mints a fresh 32-byte capability", () => {
    const first = mintCapability();
    const second = mintCapability();

    expect(first).toHaveLength(32);
    expect(second).toHaveLength(32);
    expect(capabilitiesEqual(first, second)).toBe(false);
  });

  test("rejects capabilities that are not exactly 32 bytes", () => {
    const short = makeCapability(new Uint8Array(31));
    const long = makeCapability(new Uint8Array(33));

    expect(Result.isFailure(short)).toBe(true);
    expect(Result.isFailure(long)).toBe(true);
    if (Result.isFailure(short) && Result.isFailure(long)) {
      expect(short.failure._tag).toBe("InvalidCapabilityError");
      expect(long.failure._tag).toBe("InvalidCapabilityError");
      expect(short.failure.message).not.toContain("0,0,0");
    }
  });

  test("compares validated capabilities without exposing either value", () => {
    const first = makeCapability(capabilityBytes);
    const same = makeCapability(capabilityBytes);
    const different = makeCapability(
      Uint8Array.from(capabilityBytes, (byte, index) =>
        index === 31 ? (byte + 1) % 256 : byte
      )
    );
    if (
      Result.isFailure(first) ||
      Result.isFailure(same) ||
      Result.isFailure(different)
    ) {
      throw new Error("test capabilities must be valid");
    }

    expect(capabilitiesEqual(first.success, same.success)).toBe(true);
    expect(capabilitiesEqual(first.success, different.success)).toBe(false);
  });

  test("round trips an opaque Iroh locator and capability", () => {
    const capability = makeCapability(capabilityBytes);
    expect(Result.isSuccess(capability)).toBe(true);
    if (Result.isFailure(capability)) {
      return;
    }

    const locator = "iroh-ticket-with-private-routing-details";
    const encoded = encodeBridgeLink({
      capability: capability.success,
      locator,
      transport: "iroh",
    });
    expect(Result.isSuccess(encoded)).toBe(true);
    if (Result.isFailure(encoded)) {
      return;
    }

    expect(encoded.success.startsWith("dumbridge1_")).toBe(true);
    expect(encoded.success).not.toContain(locator);

    const decoded = parseBridgeLink(encoded.success);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      return;
    }

    expect(decoded.success.transport).toBe("iroh");
    expect(decoded.success.locator).toBe(locator);
    expect([...decoded.success.capability]).toEqual([...capabilityBytes]);
  });

  test("redacts the complete bearer value", () => {
    const capability = makeCapability(capabilityBytes);
    if (Result.isFailure(capability)) {
      throw capability.failure;
    }
    const link = encodeBridgeLink({
      capability: capability.success,
      locator: "iroh-secret-locator",
      transport: "iroh",
    });
    if (Result.isFailure(link)) {
      throw link.failure;
    }

    const redacted = redactBridgeLink(link.success);

    expect(redacted).toBe("dumbridge1_[REDACTED]");
    expect(redacted).not.toContain(link.success.slice("dumbridge1_".length));
    expect(redacted).not.toContain("iroh-secret-locator");
  });

  test("rejects malformed and oversized bridge links with typed errors", () => {
    const malformed = parseBridgeLink("dumbridge1_***");
    const oversized = parseBridgeLink(`dumbridge1_${"a".repeat(16_384)}`);

    expect(Result.isFailure(malformed)).toBe(true);
    expect(Result.isFailure(oversized)).toBe(true);
    if (Result.isFailure(malformed) && Result.isFailure(oversized)) {
      expect(malformed.failure).toMatchObject({
        _tag: "InvalidBridgeLinkError",
        reason: "encoding",
      });
      expect(oversized.failure).toMatchObject({
        _tag: "InvalidBridgeLinkError",
        reason: "size",
      });
      expect(JSON.stringify(malformed.failure)).not.toContain("***");
    }
  });
});
