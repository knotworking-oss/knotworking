import { defineConfig } from "tsup";

/**
 * Bundles the MCP server (HTTP and stdio entries) and every dependency, including the workspace
 * packages, into dist/. Nothing is left to install at runtime, so there is no `runtimeExternals` list
 * (compare apps/server/tsup.config.ts) and the Docker image needs no `npm install` step. If a
 * dependency ever has to stay external, add that list here and a package script for the image, and keep
 * them in sync like the API does.
 */
export default defineConfig({
  entry: ["src/http.ts", "src/stdio.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  noExternal: [/.*/],
  // Some bundled dependencies still call require() for Node built-ins; the shebang keeps dist/stdio.js executable as a bin.
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
  },
});
