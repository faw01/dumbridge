import { readFile } from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";

const patchUrl = new URL(
  "../../../patches/iroh-ffi-proxy.patch",
  import.meta.url
);
const forkManifestUrl = new URL(
  "../../../patches/dumbridge-iroh.package.json",
  import.meta.url
);
const documentationUrl = new URL(
  "../../../docs/patches/iroh-ffi-proxy.md",
  import.meta.url
);

describe("Iroh FFI proxy source patch", () => {
  it("pins and documents the proxy and CA trust builder methods", async () => {
    const [patch, documentation] = await Promise.all([
      readFile(patchUrl, "utf8"),
      readFile(documentationUrl, "utf8"),
    ]);

    expect(patch).toContain("pub fn proxy_from_env(&self)");
    expect(patch).toContain("pub fn proxy_url(&self, url: String)");
    expect(patch).toContain("pub fn ca_extra_roots_pem(&self, pem: String)");
    expect(patch).toContain("with_extra_roots");
    expect(patch).toContain("rustls-pki-types");
    expect(patch).toContain("proxyFromEnv(): void");
    expect(patch).toContain("proxyUrl(url: string): void");
    expect(patch).toContain("caExtraRootsPem(pem: string): void");
    expect(documentation).toContain("66e628e0fd2b7d526d01b81269041c97fc97f7a5");
    expect(documentation).toContain("remaining external gate");
    expect(documentation).toContain("dumbridge-iroh");
  });

  it("pins the published fork manifest the patch was built into", async () => {
    const manifest = JSON.parse(await readFile(forkManifestUrl, "utf8")) as {
      readonly files: readonly string[];
      readonly main: string;
      readonly name: string;
      readonly version: string;
    };

    expect(manifest.name).toBe("dumbridge-iroh");
    expect(manifest.version).toBe("1.0.0-proxy.0");
    expect(manifest.main).toBe("index.js");
    expect(manifest.files).toContain("iroh.darwin-arm64.node");
    expect(manifest.files).toContain("iroh.linux-x64-gnu.node");
  });
});
