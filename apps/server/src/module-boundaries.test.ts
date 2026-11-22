import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("cross-module service boundaries", () => {
  it("uses the published APIs for stock, production, training, demand and invoice prices", () => {
    const root = fileURLToPath(new URL("./services/", import.meta.url));
    const modules = ["stock", "production", "training", "demand", "purchase-invoices"];
    const violations: string[] = [];
    for (const file of readdirSync(root).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(`${root}/${file}`, "utf8");
      for (const module of modules) {
        if (file === `${module}.ts`) continue;
        if (source.includes(`from "./${module}"`)) violations.push(`${file} imports ${module} internals`);
      }
    }
    expect(violations).toEqual([]);
  });
});
