import path from "node:path";
import type { NextConfig } from "next";

// Static export so the site can deploy to GitHub Pages (dumbridge.dev).
const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
  },
  output: "export",
  transpilePackages: ["@repo/design-system"],
  turbopack: {
    root: path.join(import.meta.dirname, "../.."),
  },
};

export default nextConfig;
