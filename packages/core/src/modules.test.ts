import { describe, expect, it } from "vitest";
import {
  ModuleConfigError,
  moduleIds,
  moduleList,
  moduleOfEntity,
  parseActiveModules,
  resolveModuleAccess,
  summarizeModules,
} from "./modules";
import { syncEntityTypes } from "./sync";

describe("module manifest", () => {
  it("only depends on modules declared earlier (so manifest order resolves dependencies)", () => {
    moduleList.forEach((m, index) => {
      for (const dep of m.dependsOn) expect(moduleIds.indexOf(dep), `${m.id} → ${dep}`).toBeLessThan(index);
    });
  });

  it("gives every sync entity at most one owner, and only known entity types", () => {
    const owned = moduleList.flatMap((m) => m.syncEntities);
    expect(new Set(owned).size).toBe(owned.length);
    for (const entity of owned) expect(syncEntityTypes).toContain(entity);
    expect(moduleOfEntity("task")).toBe("tasks");
    expect(moduleOfEntity("time_entry")).toBe("time");
    expect(moduleOfEntity("user")).toBeNull();
  });
});

describe("parseActiveModules", () => {
  it("defaults to every module that is on by default, and `all` adds the flagged ones", () => {
    const standard = moduleIds.filter((id) => id !== "calendar" && id !== "accounting" && id !== "bi");
    expect(parseActiveModules(undefined)).toEqual(standard);
    expect(parseActiveModules("  ")).toEqual(standard);
    expect(parseActiveModules("all")).toEqual([...moduleIds]);
  });

  it("keeps calendar behind its flag until it is named", () => {
    expect(parseActiveModules(undefined)).not.toContain("calendar");
    expect(parseActiveModules("tasks,calendar")).toEqual(["tasks", "calendar"]);
  });

  it("accepts a list in any order and case, and `none`", () => {
    expect(parseActiveModules("Docs, tasks")).toEqual(["tasks", "docs"]);
    expect(parseActiveModules("none")).toEqual([]);
  });

  it("refuses unknown modules and missing dependencies", () => {
    expect(() => parseActiveModules("tasks,recipies")).toThrow(ModuleConfigError);
    expect(() => parseActiveModules("time")).toThrow(/needs "tasks"/);
    expect(() => parseActiveModules("stock")).toThrow(/needs "items"/);
    expect(() => parseActiveModules("tasks,demand")).toThrow(/needs "items"/);
  });
});

describe("resolveModuleAccess", () => {
  const active = [...moduleIds];

  it("gives owners and admins manage on every active module, whatever is granted", () => {
    expect(resolveModuleAccess({ role: "admin", active: ["tasks"], grants: { tasks: "none" } })).toEqual({
      tasks: "manage",
    });
  });

  it("falls back to the role default: members write, guests read", () => {
    expect(resolveModuleAccess({ role: "member", active, grants: {} }).tasks).toBe("write");
    expect(resolveModuleAccess({ role: "guest", active, grants: {} }).tasks).toBe("read");
  });

  it("keeps opt-in modules closed until granted", () => {
    expect(resolveModuleAccess({ role: "member", active, grants: {} }).items).toBe("none");
    expect(resolveModuleAccess({ role: "member", active, grants: { items: "write" } }).items).toBe("write");
    expect(resolveModuleAccess({ role: "owner", active, grants: {} }).items).toBe("manage");
  });

  it("closes recipes without items, and opens them only with their own grant", () => {
    expect(resolveModuleAccess({ role: "member", active, grants: { recipes: "write" } }).recipes).toBe(
      "none",
    );
    expect(resolveModuleAccess({ role: "member", active, grants: { items: "read" } }).recipes).toBe("none");
    expect(
      resolveModuleAccess({ role: "member", active, grants: { items: "read", recipes: "write" } }).recipes,
    ).toBe("write");
    expect(() => parseActiveModules("recipes")).toThrow(/needs "items"/);
  });

  it("applies explicit grants, capping guests at read", () => {
    expect(resolveModuleAccess({ role: "member", active, grants: { docs: "none" } }).docs).toBe("none");
    expect(resolveModuleAccess({ role: "member", active, grants: { docs: "manage" } }).docs).toBe("manage");
    expect(resolveModuleAccess({ role: "guest", active, grants: { docs: "write" } }).docs).toBe("read");
  });

  it("closes a module when one it depends on is closed", () => {
    const access = resolveModuleAccess({ role: "member", active, grants: { tasks: "none" } });
    expect(access.time).toBe("none");
    expect(resolveModuleAccess({ role: "member", active, grants: { stock: "write" } }).stock).toBe("none");
    expect(resolveModuleAccess({ role: "member", active, grants: { demand: "write" } }).demand).toBe("none");
    expect(
      resolveModuleAccess({ role: "member", active, grants: { items: "read", demand: "write" } }).demand,
    ).toBe("write");
  });

  it("lets a token allowlist take modules away, even from an owner", () => {
    const access = resolveModuleAccess({ role: "owner", active, grants: {}, allow: ["docs", "time"] });
    expect(access).toEqual({
      tasks: "none",
      docs: "manage",
      time: "none",
      calendar: "none",
      items: "none",
      recipes: "none",
      sops: "none",
      stock: "none",
      customers: "none",
      despatch: "none",
      sales: "none",
      demand: "none",
      production: "none",
      haccp: "none",
      people: "none",
      training: "none",
      attendance: "none",
      quality: "none",
      purchasing: "none",
      costing: "none",
      site: "none",
      labels: "none",
      specifications: "none",
      testing: "none",
      npd: "none",
      defence: "none",
      governance: "none",
      hse: "none",
      hse_incidents: "none",
      assistant: "none",
      accounting: "none",
      workforce: "none",
      workforce_hr: "none",
      bi: "none",
    });
  });

  it("leaves inactive modules out", () => {
    const access = resolveModuleAccess({ role: "owner", active: ["docs"], grants: {} });
    expect(access).toEqual({ docs: "manage" });
    expect(summarizeModules(access).map((m) => m.id)).toEqual(["docs"]);
  });
});
