import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Date helpers are local-time based and Intl falls back to the environment locale. Pin both to a
// non-UTC zone (with DST) so tests catch time-zone bugs and don't depend on the machine running them.
process.env.TZ = "America/New_York";
process.env.LC_ALL = "en_US.UTF-8";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
  },
});
