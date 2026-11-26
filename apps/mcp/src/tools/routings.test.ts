import { newId } from "@knotworking/core";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "../testing/harness";

type Session = Awaited<ReturnType<typeof connect>>;
const open: Session[] = [];
async function session(options: Parameters<typeof connect>[0] = {}) {
  const s = await connect(options);
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("routing tools", () => {
  it("are tagged with the routings module, with no approval or void tool", async () => {
    const { client } = await session({ modules: ["items", "recipes", "stock", "production", "routings"] });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_work_centres", "create_routing", "complete_job_card"]));
    expect(names.filter((n) => /approve_routing|void_job_card/.test(n))).toEqual([]);
    const { client: without } = await session({ modules: ["items", "recipes", "stock", "production"] });
    expect((await without.listTools()).tools.map((t) => t.name)).not.toContain("list_job_cards");
  });

  it("keeps work centres, drafts a routing and records work on job cards", async () => {
    const { call, fake } = await session({ modules: ["items", "recipes", "stock", "production", "routings"] });
    const cut = (await call("list_work_centres", { workspace: "acme" })).data.workCentres[0];
    expect(cut).toMatchObject({ code: "CUT" });
    const weld = await call("save_work_centre", {
      workspace: "acme",
      work_centre: { code: "WELD", name: "Welding bay", costPerHour: 45 },
    });
    expect(weld.data).toMatchObject({ created: true, code: "WELD", stations: 1 });
    const bad = await call("save_work_centre", { workspace: "acme", work_centre: { code: "", name: "x" } });
    expect(bad.data.error.code).toBe("invalid_input");

    const routing = await call("create_routing", {
      workspace: "acme",
      code: "R-FRAME",
      name: "Frame",
      bom_id: newId(),
      operations: [
        { name: "Cut", work_centre_id: cut.id, setup_minutes: 10, run_minutes: 5 },
        { name: "Weld", work_centre_id: weld.data.id, run_minutes: 20 },
      ],
    });
    expect(routing.isError).toBe(false);
    expect(routing.data.versions[0].operations.map((o: { name: string }) => o.name)).toEqual(["Cut", "Weld"]);
    fake.routingsModule.approve(routing.data.id);

    const made = await call("create_job_cards", { workspace: "acme", batch_id: newId() });
    const [first, second] = made.data.jobCards;
    await call("record_job_card_time", { workspace: "acme", job_card_id: first.id, minutes: 30 });
    await call("record_job_card_quantity", { workspace: "acme", job_card_id: first.id, good: 3, unit: "each" });
    const over = await call("record_job_card_quantity", {
      workspace: "acme",
      job_card_id: second.id,
      good: 4,
      unit: "each",
    });
    expect(over.data.error.code).toBe("exceeds_previous_good");
    await call("raise_job_card_exception", {
      workspace: "acme",
      job_card_id: first.id,
      kind: "machine",
      description: "Blade worn",
    });
    const blocked = await call("complete_job_card", { workspace: "acme", job_card_id: first.id });
    expect(blocked.data.error.code).toBe("open_exceptions");
    const listed = await call("list_job_cards", { workspace: "acme" });
    expect(listed.data).toMatchObject({ total: 2, hasMore: false });
    expect((await call("get_job_card", { workspace: "acme", job_card_id: first.id })).data).toMatchObject({
      actualMinutes: 30,
      good: 3,
    });
  });
});
