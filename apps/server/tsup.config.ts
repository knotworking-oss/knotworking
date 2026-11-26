import { defineConfig } from "tsup";

/**
 * Bundles the API (and workspace packages) into dist/ so the production image
 * only needs the few packages that can't be bundled.
 */
// Keep in sync with scripts/runtime-package.mjs (installed separately in the Docker image).
export const runtimeExternals = ["@electric-sql/pglite", "postgres", "nodemailer", "pdfkit"];

export default defineConfig({
  entry: ["src/index.ts", "src/migrate.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  // Bundle everything except the runtime externals (tsup's noExternal wins over external).
  noExternal: [new RegExp(`^(?!(${runtimeExternals.map((p) => p.replace("/", "\\/")).join("|")})(\\/|$))`)],
  external: runtimeExternals,
  // Some bundled dependencies still call require() for Node built-ins.
  banner: {
    js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
  },
});
