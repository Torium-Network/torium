import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMDX } from "fumadocs-mdx/next";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(configDir, "../..");
const versionManifest = JSON.parse(
  readFileSync(path.join(configDir, "content/versions.json"), "utf8")
);
const currentVersion = versionManifest.current;

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/docs",
  // Self-hosted deployments package the server output into a container.
  output: process.env.DOCKER_BUILD === "1" ? "standalone" : undefined,
  reactStrictMode: true,
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },
  async redirects() {
    return [
      {
        source: "/latest",
        destination: `/${currentVersion}`,
        permanent: false,
      },
      {
        source: "/latest/:path*",
        destination: `/${currentVersion}/:path*`,
        permanent: false,
      },
    ];
  },
};

export default withMDX(nextConfig);
