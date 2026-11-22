import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("./", import.meta.url);
function sourceFiles(dir = root): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(new URL(`${e.name}/`, dir))
      : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")
        ? [new URL(e.name, dir)]
        : [],
  );
}

describe("the MCP server is just another API client", () => {
  it("never imports the database or server internals", () => {
    for (const file of sourceFiles()) {
      const code = readFileSync(file, "utf8");
      expect(code, file.pathname).not.toMatch(/from\s+["']@knotworking\/(db|server)(\/[^"']*)?["']/);
      expect(code, file.pathname).not.toMatch(/from\s+["'](\.\.\/)+(server|db)\//);
    }
  });

  it("only depends on packages declared in package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
    for (const file of sourceFiles()) {
      const code = readFileSync(file, "utf8");
      for (const [, name] of code.matchAll(/from\s+["']((?:@[^/"']+\/)?[^./"'][^/"']*)/g)) {
        if (name!.startsWith("node:")) continue;
        expect(declared.has(name!), `${file.pathname} imports undeclared ${name}`).toBe(true);
      }
    }
  });
});
