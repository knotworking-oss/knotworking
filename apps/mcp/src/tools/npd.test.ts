import { afterEach, describe, expect, it } from "vitest";
import { connect } from "../testing/harness";

type Session = Awaited<ReturnType<typeof connect>>;
const open: Session[] = [];
async function session() {
  const s = await connect();
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("product development tools", () => {
  it("drafts a project, links its recipe and records trials against the checklist", async () => {
    const { call, client } = await session();
    const created = await call("save_npd_project", {
      workspace: "acme",
      code: "NPD-1",
      name: "Lemon sponge",
      brief: "A lemon twist on the Victoria sponge",
      target_launch_on: "2026-06-01",
      target_shelf_life_days: 7,
      storage: "ambient",
    });
    expect(created.data).toMatchObject({ code: "NPD-1", status: "brief", readyToLaunch: false });
    expect(created.data.note).toMatch(/no tools/);
    const linked = await call("save_npd_project", {
      workspace: "acme",
      project: "npd-1",
      item: "BOX-12",
      recipe: "SPONGE",
    });
    expect(linked.data).toMatchObject({ item: "BOX-12", recipe: "SPONGE" });
    expect(linked.data.checklist.find((c: { check: string }) => c.check === "Recipe approved").status).toBe(
      "met",
    );
    const shelf = await call("record_npd_trial", {
      workspace: "acme",
      project: "NPD-1",
      kind: "shelf_life",
      held_on: "2026-01-04",
      description: "Ambient, sealed",
      outcome: "pass",
      achieved_shelf_life_days: 9,
    });
    expect(shelf.data.status).toBe("trials");
    expect(shelf.data.checklist.find((c: { check: string }) => c.check === "Shelf life proven").status).toBe(
      "met",
    );
    const badVersion = await call("record_npd_trial", {
      workspace: "acme",
      project: "NPD-1",
      kind: "factory",
      held_on: "2026-01-04",
      description: "Line 1",
      outcome: "pass",
      recipe_version: 9,
    });
    expect(badVersion.isError).toBe(true);
    const list = await call("list_npd_projects", { workspace: "acme" });
    expect(list.data.projects).toEqual([expect.objectContaining({ code: "NPD-1", trials: 1 })]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.some((n) => /launch|signoff|sign_off/.test(n))).toBe(false);
  });
});
