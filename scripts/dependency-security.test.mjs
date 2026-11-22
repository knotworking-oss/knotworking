import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

// Exercise the actual patched transitive dependency used by the UI tooling.
const uiRequire = createRequire(new URL("../packages/ui/package.json", import.meta.url));
const shadcnRequire = createRequire(uiRequire.resolve("shadcn"));
const merge = shadcnRequire("deepmerge");

test("deepmerge cannot poison the result prototype through target or source keys", () => {
  const poisoned = JSON.parse('{"__proto__":{"isAdmin":true},"safe":{"value":1}}');
  for (const result of [merge(poisoned, {}), merge(Object.create(null), poisoned)]) {
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(result.isAdmin, undefined);
    assert.equal(result.safe.value, 1);
  }
  assert.equal({}.isAdmin, undefined);
});

test("deepmerge preserves nested merging, arrays and custom merge behavior", () => {
  assert.deepEqual(merge({ nested: { a: 1 }, items: [1] }, { nested: { b: 2 }, items: [2] }), {
    nested: { a: 1, b: 2 },
    items: [1, 2],
  });
  assert.deepEqual(
    merge(
      { count: 1 },
      { count: 2 },
      {
        customMerge: (key) => (key === "count" ? (a, b) => a + b : undefined),
        isMergeableObject: () => true,
      },
    ),
    { count: 3 },
  );
});
