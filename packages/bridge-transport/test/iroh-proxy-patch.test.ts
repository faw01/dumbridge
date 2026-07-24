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
    expect(documentation).toContain("bc7eb0d28a5389323abdf9a878c8f3b45bdcb499");
    expect(documentation).toContain("remaining external gate");
    expect(documentation).toContain("dumbridge-iroh");
  });

  it("pins the published fork manifest the patch was built into", async () => {
    const manifest = JSON.parse(await readFile(forkManifestUrl, "utf8")) as {
      readonly main: string;
      readonly name: string;
      readonly optionalDependencies: Readonly<Record<string, string>>;
      readonly types: string;
      readonly version: string;
    };

    expect(manifest.name).toBe("dumbridge-iroh");
    expect(manifest.version).toBe("1.1.0");
    expect(manifest.main).toBe("index.js");
    expect(manifest.types).toBe("index.d.ts");
    expect(Object.keys(manifest.optionalDependencies).sort()).toEqual([
      "dumbridge-iroh-android-arm-eabi",
      "dumbridge-iroh-android-arm64",
      "dumbridge-iroh-darwin-arm64",
      "dumbridge-iroh-linux-arm-gnueabihf",
      "dumbridge-iroh-linux-arm-musleabihf",
      "dumbridge-iroh-linux-arm64-gnu",
      "dumbridge-iroh-linux-arm64-musl",
      "dumbridge-iroh-linux-x64-gnu",
      "dumbridge-iroh-linux-x64-musl",
      "dumbridge-iroh-win32-arm64-msvc",
      "dumbridge-iroh-win32-x64-msvc",
    ]);
    expect(
      Object.values(manifest.optionalDependencies).every(
        (pinned) => pinned === manifest.version
      )
    ).toBe(true);
  });
});
