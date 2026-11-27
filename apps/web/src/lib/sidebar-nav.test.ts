import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assistantModuleForPath,
  hasModuleLevel,
  moduleIds,
  type ModuleAccessLevel,
  type ModuleId,
} from "@knotworking/core";
import { describe, expect, it } from "vitest";
import {
  areaForPath,
  areaHref,
  getArea,
  globalRoots,
  groupAreas,
  pinnedItems,
  visiblePinned,
  wikiItem,
  homePath,
  navAreas,
  resolveArea,
  visibleAreas,
  visibleSections,
  isItemActive,
  type NavAccess,
} from "./sidebar-nav";

const accessFor = (levels: Partial<Record<ModuleId, ModuleAccessLevel>>, canEdit = true): NavAccess => ({
  can: (id, level = "read") => hasModuleLevel(levels[id], level),
  canEdit,
  isActive: (id) => id in levels,
});
const everything = accessFor(Object.fromEntries(moduleIds.map((id) => [id, "manage" as const])));

// Vitest runs from apps/web.
const appDir = resolve(process.cwd(), "src/app/[workspace]");

describe("navAreas", () => {
  it("has unique ids, and every module area is a real module", () => {
    const ids = navAreas.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids)
      expect(id === "workspace" || (moduleIds as readonly string[]).includes(id)).toBe(true);
  });

  it("only links to pages that exist", () => {
    const missing = [...navAreas.flatMap((a) => a.sections.flatMap((s) => s.items)), ...pinnedItems, wikiItem]
      .filter((i) => !existsSync(`${appDir}/${i.path}/page.tsx`))
      .map((i) => i.path);
    expect(missing).toEqual([]);
  });

  it("lists each page once, pinned pages included", () => {
    const paths = [
      ...navAreas.flatMap((a) => a.sections.flatMap((s) => s.items.map((i) => i.path))),
      ...pinnedItems.map((i) => i.path),
      wikiItem.path,
    ];
    expect(paths.filter((p, i) => paths.indexOf(p) !== i)).toEqual([]);
  });

  it("covers every top-level page, so none is unreachable from the sidebar", () => {
    const roots = readdirSync(appDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    // Always in the sidebar (tasks, calendar, wiki, inbox, with their detail pages), or not a page.
    const alwaysThere = new Set([...globalRoots, "api"]);
    const unreachable = roots.filter(
      (r) => !alwaysThere.has(r) && areaForPath(`/acme/${r}`, "acme") === null,
    );
    expect(unreachable).toEqual([]);
  });
});

describe("the assistant's page module", () => {
  // The assistant starts a turn with the tools of the module the person is looking at.
  it("finds a module for every page of a module area", () => {
    for (const area of navAreas) {
      if (!(moduleIds as readonly string[]).includes(area.id)) continue;
      for (const item of area.sections.flatMap((s) => s.items)) {
        const found = assistantModuleForPath(`/acme/${item.path}`);
        const segment = item.path.split("/")[0]!;
        // The area's module, or the page's own module when it has one (workforce in People).
        expect([area.id, segment], item.path).toContain(found);
      }
    }
  });

  it("maps task pages to tasks, and nothing for workspace pages", () => {
    expect(assistantModuleForPath("/acme/my-tasks")).toBe("tasks");
    expect(assistantModuleForPath("/acme/projects/website?view=board")).toBe("tasks");
    expect(assistantModuleForPath("/acme/settings/members")).toBeNull();
    expect(assistantModuleForPath("/acme")).toBeNull();
    expect(assistantModuleForPath(undefined)).toBeNull();
  });
});

describe("visibility", () => {
  it("shows only the modules the viewer can read, plus the workspace area", () => {
    const ids = visibleAreas(accessFor({ docs: "read", items: "write" })).map((a) => a.id);
    expect(ids).toEqual(["items", "workspace"]);
  });

  it("hides items that need more access or another module", () => {
    const labelsOf = (access: NavAccess) =>
      visibleSections(getArea("haccp")!, access).flatMap((s) => s.items.map((i) => i.label));
    expect(labelsOf(accessFor({ haccp: "write" }))).not.toContain("Review");
    expect(labelsOf(accessFor({ haccp: "manage" }))).toContain("Review");

    const people = (access: NavAccess) =>
      visibleSections(getArea("people")!, access).flatMap((s) => s.items.map((i) => i.label));
    expect(people(accessFor({ people: "read" }))).toEqual(["People"]);
    expect(people(accessFor({ people: "read", workforce: "read", workforce_hr: "read" }))).toContain(
      "Private HR records",
    );
  });

  it("offers the concern form to everyone while management review is on, and the org chart to non-guests", () => {
    const labels = (access: NavAccess) =>
      visibleSections(getArea("workspace")!, access).flatMap((s) => s.items.map((i) => i.label));
    expect(labels(accessFor({ governance: "none" }, false))).toEqual([
      "Members",
      "Teams & workflows",
      "Raise a concern",
    ]);
    expect(labels(accessFor({}, true))).toEqual(["Members", "Org chart", "Teams & workflows"]);
    expect(labels(accessFor({ tasks: "read", calendar: "read" }))).toEqual([
      "Members",
      "Org chart",
      "Teams & workflows",
      "Task labels",
      "Connected calendars",
    ]);
  });

  it("keeps tasks, the calendar and the wiki out of the module list: they are always there", () => {
    const ids = navAreas.map((a) => a.id);
    expect(ids).not.toContain("tasks");
    expect(ids).not.toContain("calendar");
    expect(ids).not.toContain("docs");
  });

  it("pins task planning and the calendar, and links the wiki, for those who can use them", () => {
    const labels = (a: NavAccess) => visiblePinned(a).map((i) => i.label);
    expect(labels(accessFor({ tasks: "read", calendar: "read" }))).toEqual([
      "My tasks",
      "Views",
      "Projects",
      "Calendar",
    ]);
    expect(labels(accessFor({ tasks: "read" }))).toEqual(["My tasks", "Views", "Projects"]);
    expect(labels(accessFor({ docs: "read" }))).toEqual([]);
    expect(wikiItem.show?.(accessFor({ docs: "read" }))).toBe(true);
    expect(wikiItem.show?.(accessFor({ tasks: "read" }))).toBe(false);
  });

  it("groups areas in menu order", () => {
    const groups = groupAreas(visibleAreas(everything));
    expect(groups.map((g) => g.group)).toEqual(["Work", "Operations", "People", "Workspace"]);
  });
});

describe("areaForPath", () => {
  it("finds the area of a page or anything beneath it", () => {
    expect(areaForPath("/acme/items", "acme")).toBe("items");
    expect(areaForPath("/acme/recipes/abc", "acme")).toBe("recipes");
    expect(areaForPath("/acme/haccp/plans/p1", "acme")).toBe("haccp");
    expect(areaForPath("/acme/time", "acme")).toBe("time");
  });

  it("prefers the longest match", () => {
    expect(areaForPath("/acme/workforce/hr", "acme")).toBe("people");
    expect(areaForPath("/acme/settings/labels", "acme")).toBe("workspace");
    expect(areaForPath("/acme/labels", "acme")).toBe("labels");
    expect(areaForPath("/acme/settings/members", "acme")).toBe("workspace");
    expect(areaForPath("/acme/settings/api-tokens", "acme")).toBe("workspace");
  });

  it("places detail pages that are not in a sidebar", () => {
    expect(areaForPath("/acme/suppliers/s1", "acme")).toBe("items");
  });

  it("has no area for global pages, the home page or other workspaces", () => {
    for (const path of [
      "inbox",
      "my-tasks",
      "projects/p1",
      "task/t1",
      "team/ENG",
      "calendar",
      "docs",
      "docs/d1",
    ]) {
      expect(areaForPath(`/acme/${path}`, "acme")).toBeNull();
    }
    expect(areaForPath("/acme", "acme")).toBeNull();
    expect(areaForPath("/other/items", "acme")).toBeNull();
    expect(areaForPath("/acmeitems", "acme")).toBeNull();
  });
});

describe("isItemActive", () => {
  const overview = { label: "Stock", path: "stock", exact: true };
  const section = { label: "Items", path: "items" };
  it("matches exact items on their own page only", () => {
    expect(isItemActive(overview, "/acme/stock", "acme")).toBe(true);
    expect(isItemActive(overview, "/acme/stock/locations", "acme")).toBe(false);
  });
  it("matches other items beneath their page", () => {
    expect(isItemActive(section, "/acme/items/i1", "acme")).toBe(true);
    expect(isItemActive(section, "/acme/itemsx", "acme")).toBe(false);
  });
});

describe("resolveArea", () => {
  const access = accessFor({ docs: "write", items: "write", time: "write" });
  const resolve = (over: Partial<Parameters<typeof resolveArea>[0]>) =>
    resolveArea({ pathname: "/acme/inbox", slug: "acme", stored: null, preferred: null, access, ...over }).id;

  it("follows the page the viewer is on", () => {
    expect(resolve({ pathname: "/acme/items", stored: "time", preferred: "time" })).toBe("items");
  });
  it("falls back to the last choice, then the default, then the first area they can open", () => {
    expect(resolve({ stored: "items", preferred: "time" })).toBe("items");
    expect(resolve({ preferred: "items" })).toBe("items");
    expect(resolve({})).toBe("workspace");
  });
  it("ignores areas the viewer can't open", () => {
    expect(resolve({ stored: "haccp", preferred: "stock" })).toBe("workspace");
    expect(resolve({ pathname: "/acme/haccp" })).toBe("workspace");
  });
  it("always resolves to something", () => {
    expect(resolve({ access: accessFor({}) })).toBe("workspace");
  });
});

describe("homePath", () => {
  const access = accessFor({ tasks: "write", docs: "write", items: "write", haccp: "manage" });
  it("opens the default module's first page", () => {
    expect(homePath({ slug: "acme", preferred: "items", access })).toBe("/acme/items");
    expect(homePath({ slug: "acme", preferred: "haccp", access })).toBe("/acme/haccp");
  });
  it("keeps the old landing page when there is no usable default", () => {
    expect(homePath({ slug: "acme", preferred: null, access })).toBe("/acme/my-tasks");
    expect(homePath({ slug: "acme", preferred: "stock", access })).toBe("/acme/my-tasks");
    expect(homePath({ slug: "acme", preferred: "nonsense", access: accessFor({ docs: "read" }) })).toBe(
      "/acme/docs",
    );
    expect(homePath({ slug: "acme", preferred: null, access: accessFor({}) })).toBe("/acme/inbox");
  });
  it("areaHref opens the first page the viewer can see", () => {
    expect(areaHref(getArea("people")!, "acme", accessFor({ people: "read" }))).toBe("/acme/people");
  });
});
