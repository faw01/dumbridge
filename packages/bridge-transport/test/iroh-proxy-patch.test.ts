import { describe, expect, test } from "bun:test";

const patchUrl = new URL(
  "../../../patches/iroh-ffi-proxy.patch",
  import.meta.url
);
const documentationUrl = new URL(
  "../../../docs/patches/iroh-ffi-proxy.md",
  import.meta.url
);

describe("Iroh FFI proxy source patch", () => {
  test("pins and documents the two proxy builder methods", async () => {
    const [patch, documentation] = await Promise.all([
      Bun.file(patchUrl).text(),
      Bun.file(documentationUrl).text(),
    ]);

    expect(patch).toContain("pub fn proxy_from_env(&self)");
    expect(patch).toContain("pub fn proxy_url(&self, url: String)");
    expect(patch).toContain("proxyFromEnv(): void");
    expect(patch).toContain("proxyUrl(url: string): void");
    expect(documentation).toContain("66e628e0fd2b7d526d01b81269041c97fc97f7a5");
    expect(documentation).toContain("remaining external gate");
  });
});
