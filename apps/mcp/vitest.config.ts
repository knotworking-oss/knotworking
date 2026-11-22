import { defineConfig } from "vitest/config";

// The tool suites run twice: once calling every tool by name (`?list=all`), and once as a
// catalogue-mode agent would, through find_records / get_record / run_module_tool (see
// src/testing/harness.ts). Both must pass.
export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: "all" } },
      {
        extends: true,
        test: {
          name: "catalogue",
          include: ["src/tools.test.ts", "src/tools/**/*.test.ts"],
          env: { MCP_TEST_LIST_MODE: "catalogue" },
        },
      },
    ],
  },
});
