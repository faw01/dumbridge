import { describe, expect, test } from "bun:test";
import {
  capabilitiesEqual,
  checkBridgeKeyExpiry,
  encodeBridgeKey,
  makeCapability,
  mintCapability,
  parseBridgeKey,
  redactBridgeKey,
} from "@dumbridge/bridge-key";
import { Encoding, Result } from "effect";

const capabilityBytes = Uint8Array.from({ length: 32 }, (_, index) => index);
const testExpiresAt = 1_752_600_000_000;

describe("BridgeKey", () => {
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
    const encoded = encodeBridgeKey({
      capability: capability.success,
      expiresAt: testExpiresAt,
      locator,
      transport: "iroh",
    });
    expect(Result.isSuccess(encoded)).toBe(true);
    if (Result.isFailure(encoded)) {
      return;
    }

    expect(encoded.success.startsWith("dumbridge1_")).toBe(true);
    expect(encoded.success).not.toContain(locator);

    const decoded = parseBridgeKey(encoded.success);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      return;
    }

    expect(decoded.success.transport).toBe("iroh");
    expect(decoded.success.locator).toBe(locator);
    expect(decoded.success.expiresAt).toBe(testExpiresAt);
    expect(decoded.success.version).toBe(2);
    expect([...decoded.success.capability]).toEqual([...capabilityBytes]);
  });

  test("parses a version 1 key without an expiry deadline", () => {
    const capability = makeCapability(capabilityBytes);
    if (Result.isFailure(capability)) {
      throw capability.failure;
    }
    const payload = JSON.stringify({
      capability: Encoding.encodeBase64Url(capability.success),
      locator: "iroh-ticket-minted-before-key-ttl",
      transport: "iroh",
      version: 1,
    });
    const legacyKey = `dumbridge1_${Encoding.encodeBase64Url(new TextEncoder().encode(payload))}`;

    const decoded = parseBridgeKey(legacyKey);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      return;
    }

    expect(decoded.success.version).toBe(1);
    expect(decoded.success.expiresAt).toBeUndefined();
    expect(
      Result.isSuccess(checkBridgeKeyExpiry(decoded.success.expiresAt, 1))
    ).toBe(true);
  });

  test("reports key expiry only once the deadline passes", () => {
    expect(
      Result.isSuccess(checkBridgeKeyExpiry(testExpiresAt, testExpiresAt - 1))
    ).toBe(true);

    const atDeadline = checkBridgeKeyExpiry(testExpiresAt, testExpiresAt);
    const pastDeadline = checkBridgeKeyExpiry(testExpiresAt, testExpiresAt + 1);
    expect(Result.isFailure(atDeadline)).toBe(true);
    expect(Result.isFailure(pastDeadline)).toBe(true);
    if (Result.isFailure(atDeadline) && Result.isFailure(pastDeadline)) {
      expect(atDeadline.failure._tag).toBe("BridgeKeyExpiredError");
      expect(atDeadline.failure.expiresAt).toBe(testExpiresAt);
      expect(pastDeadline.failure.message).toContain(
        new Date(testExpiresAt).toISOString()
      );
      expect(pastDeadline.failure.message).not.toContain("dumbridge1_");
    }
  });

  test("redacts the complete bearer value", () => {
    const capability = makeCapability(capabilityBytes);
    if (Result.isFailure(capability)) {
      throw capability.failure;
    }
    const link = encodeBridgeKey({
      capability: capability.success,
      expiresAt: testExpiresAt,
      locator: "iroh-secret-locator",
      transport: "iroh",
    });
    if (Result.isFailure(link)) {
      throw link.failure;
    }

    const redacted = redactBridgeKey(link.success);

    expect(redacted).toBe("dumbridge1_[REDACTED]");
    expect(redacted).not.toContain(link.success.slice("dumbridge1_".length));
    expect(redacted).not.toContain("iroh-secret-locator");
  });

  test("rejects malformed and oversized bridge keys with typed errors", () => {
    const malformed = parseBridgeKey("dumbridge1_***");
    const oversized = parseBridgeKey(`dumbridge1_${"a".repeat(16_384)}`);

    expect(Result.isFailure(malformed)).toBe(true);
    expect(Result.isFailure(oversized)).toBe(true);
    if (Result.isFailure(malformed) && Result.isFailure(oversized)) {
      expect(malformed.failure).toMatchObject({
        _tag: "InvalidBridgeKeyError",
        reason: "encoding",
      });
      expect(oversized.failure).toMatchObject({
        _tag: "InvalidBridgeKeyError",
        reason: "size",
      });
      expect(JSON.stringify(malformed.failure)).not.toContain("***");
    }
  });
});
