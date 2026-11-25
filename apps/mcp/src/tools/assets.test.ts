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

describe("asset register tools", () => {
  it("are tagged with the assets module, with no archive tool", async () => {
    const { client } = await session({ modules: ["assets"] });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_assets", "get_asset", "save_asset"]));
    expect(names.filter((n) => /archive|restore|delete_asset/.test(n))).toEqual([]);
    const { client: without } = await session({ modules: ["tasks"] });
    expect((await without.listTools()).tools.map((t) => t.name)).not.toContain("list_assets");
  });

  it("lists and reads assets as resources, through the catalogue too", async () => {
    const { call } = await session({ modules: ["assets"], listMode: "catalogue" });
    const areas = await call("list_assets", { workspace: "acme", kind: "area" });
    expect(areas.isError).toBe(false);
    expect(areas.data.assets.map((a: { name: string }) => a.name)).toEqual(["Packing hall", "Dispatch"]);
    expect(areas.data).toMatchObject({ total: 2, hasMore: false });
    const van = (await call("list_assets", { workspace: "acme", q: "van" })).data.assets[0];
    const detail = await call("get_asset", { workspace: "acme", asset_id: van.id });
    expect(detail.data).toMatchObject({ id: van.id, kind: "vehicle", code: "VAN-1" });
  });

  it("adds an asset in a named area and changes it", async () => {
    const { call, fake } = await session({ modules: ["assets"] });
    const added = await call("save_asset", {
      workspace: "acme",
      asset: { kind: "equipment", code: "MX-1", name: "Mixer", area: "dsp", serialNumber: "S-1" },
    });
    expect(added.data).toMatchObject({ created: true, name: "Mixer", parentArea: { name: "Dispatch" } });
    const changed = await call("save_asset", {
      workspace: "acme",
      id: added.data.id,
      asset: { name: "Mixer 1", area: null },
    });
    expect(changed.data).toMatchObject({ created: false, name: "Mixer 1", parentAreaId: null });
    expect(fake.assetsModule.assets.at(-1)).toMatchObject({ code: "MX-1", name: "Mixer 1" });
    const bad = await call("save_asset", { workspace: "acme", asset: { kind: "boat", name: "Dinghy" } });
    expect(bad.data.error.code).toBe("invalid_input");
    const missingArea = await call("save_asset", {
      workspace: "acme",
      asset: { kind: "tool", name: "Drill", area: "Roof" },
    });
    expect(missingArea.data.error.code).toBe("not_found");
  });
});
