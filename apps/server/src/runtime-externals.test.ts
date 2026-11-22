import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runtimeExternals } from "../tsup.config";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The string array assigned to `const externals` in scripts/runtime-package.mjs. */
function scriptExternals(): string[] {
  const match = read("../scripts/runtime-package.mjs").match(/const externals = \[([^\]]*)\]/);
  if (!match) throw new Error("scripts/runtime-package.mjs no longer declares `const externals = [...]`");
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("runtime externals", () => {
  it("tsup.config.ts and scripts/runtime-package.mjs list the same packages", () => {
    // The Docker image installs the script's list; anything bundled-external but missing there
    // crashes at startup, and anything listed there but bundled just bloats the image.
    expect([...scriptExternals()].sort()).toEqual([...runtimeExternals].sort());
  });

  it("every external is a dependency of the server package", () => {
    const pkg = JSON.parse(read("../package.json")) as { dependencies: Record<string, string> };
    for (const name of runtimeExternals) expect(pkg.dependencies, name).toHaveProperty(name);
  });
});
