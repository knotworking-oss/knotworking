import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const config: NextConfig = {
  // Self-contained server bundle for Docker (see Dockerfile).
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  // Don't advertise the framework in an X-Powered-By header.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@knotworking/ui", "@knotworking/core", "@knotworking/api-client"],
  turbopack: {
    root: repoRoot,
  },
  devIndicators: { position: "bottom-right" },
};

export default config;
