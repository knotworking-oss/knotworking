import { describe, expect, it } from "vitest";
import { assetCreateSchema, assetListQuerySchema, assetUpdateSchema } from "./assets";
import {
  activeWorkspaceModules,
  moduleIds,
  modules,
  parseActiveModules,
  workspacePresetModules,
} from "./modules";

describe("asset validation", () => {
  it("takes a kind and a name, and blanks optional text", () => {
    const parsed = assetCreateSchema.parse({ kind: "vehicle", name: " Van 1 ", code: "", serialNumber: " " });
    expect(parsed).toMatchObject({ kind: "vehicle", name: "Van 1", code: null, serialNumber: null });
    expect(assetCreateSchema.safeParse({ kind: "boat", name: "Dinghy" }).success).toBe(false);
    expect(assetCreateSchema.safeParse({ kind: "it", name: "" }).success).toBe(false);
  });

  it("keeps money to two decimals and dates as ISO days", () => {
    expect(assetCreateSchema.safeParse({ kind: "tool", name: "Drill", purchaseCost: 129.99 }).success).toBe(
      true,
    );
    expect(assetCreateSchema.safeParse({ kind: "tool", name: "Drill", purchaseCost: 1.005 }).success).toBe(
      false,
    );
    expect(assetCreateSchema.safeParse({ kind: "tool", name: "Drill", purchaseCost: -1 }).success).toBe(
      false,
    );
    expect(
      assetCreateSchema.safeParse({ kind: "tool", name: "Drill", warrantyExpiresOn: "2027-02-30" }).success,
    ).toBe(false);
  });

  it("needs something to change; the revision alone is not a change", () => {
    expect(assetUpdateSchema.safeParse({}).success).toBe(false);
    expect(assetUpdateSchema.safeParse({ expectedRevision: 2 }).success).toBe(false);
    expect(assetUpdateSchema.safeParse({ name: "Van 2", expectedRevision: 2 }).success).toBe(true);
    // Archiving is its own action, not a field.
    expect(assetUpdateSchema.safeParse({ status: "archived" }).success).toBe(false);
  });

  it("lists active assets a page at a time by default", () => {
    expect(assetListQuerySchema.parse({})).toEqual({ status: "active", limit: 100, offset: 0 });
    expect(assetListQuerySchema.parse({ kind: "area", status: "all", limit: "10" })).toMatchObject({
      kind: "area",
      status: "all",
      limit: 10,
    });
  });
});

describe("the assets module's place in the manifest", () => {
  it("needs nothing, comes before the modules that need it, and is opt-in", () => {
    expect(modules.assets.dependsOn).toEqual([]);
    expect(modules.assets.defaultAccess).toBe("none");
    expect(modules.assets.syncEntities).toEqual(["asset"]);
    expect(parseActiveModules("assets")).toEqual(["assets"]);
    for (const dependant of ["haccp", "site"] as const) {
      expect(modules[dependant].dependsOn).toContain("assets");
      expect(moduleIds.indexOf("assets")).toBeLessThan(moduleIds.indexOf(dependant));
    }
  });

  it("is in the general business preset, and a selection without it drops HACCP and Site", () => {
    expect(workspacePresetModules("general_business")).toContain("assets");
    expect(activeWorkspaceModules([...moduleIds], ["haccp", "site"])).toEqual([]);
    expect(activeWorkspaceModules([...moduleIds], ["assets", "site"])).toEqual(["assets", "site"]);
  });
});
