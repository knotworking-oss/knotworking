import { describe, expect, it } from "vitest";
import { isModuleId } from "./modules";
import { tokenActionLogQuerySchema, tokenActionUpdateSchema } from "./schemas";
import {
  isTokenActionId,
  personOnlyActions,
  personOnlyReasons,
  tokenActionIds,
  tokenActionList,
  tokenActionRefusal,
  tokenActions,
} from "./token-actions";

describe("token actions", () => {
  it("keys every action by its own id, in a module, prefixed with that module", () => {
    expect(Object.keys(tokenActions).sort()).toEqual([...tokenActionIds].sort());
    expect(tokenActionList.map((a) => a.id)).toEqual([...tokenActionIds]);
    for (const [key, action] of Object.entries(tokenActions)) {
      expect(action.id).toBe(key);
      expect(isModuleId(action.module)).toBe(true);
      expect(key.startsWith(`${action.module}.`)).toBe(true);
      expect(["write", "manage"]).toContain(action.level);
    }
    expect(new Set(tokenActionList.map((a) => a.label)).size).toBe(tokenActionList.length);
  });

  it("lists person-only actions with a reason, distinct from the toggleable ones", () => {
    const labels = personOnlyActions.map((a) => a.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const a of personOnlyActions) {
      expect(isModuleId(a.module)).toBe(true);
      expect(a.reason).toBe(personOnlyReasons[a.kind]);
    }
    for (const a of tokenActionList) expect(labels).not.toContain(a.label);
  });

  it("recognises ids and parses requests", () => {
    expect(isTokenActionId("stock.waste")).toBe(true);
    expect(isTokenActionId("stock.reverse")).toBe(false);
    expect(tokenActionUpdateSchema.safeParse({ enabled: "yes" }).success).toBe(false);
    expect(tokenActionLogQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(tokenActionLogQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(tokenActionRefusal("stock.waste")).toBe(
      'API tokens can\'t record waste in this workspace unless an owner or admin allows "Record waste" under Settings → API access',
    );
  });
});
