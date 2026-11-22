import { defineConfig } from "vitest/config";
export default defineConfig({
  root: new URL("..", import.meta.url).pathname,
  test: {
    include: ["sim/**/*.sim.ts"],
    testTimeout: 0,
    hookTimeout: 0,
    pool: "forks",
    silent: false,
    fileParallelism: false,
  },
});
