import { tokenActionIds } from "@knotworking/core";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeApi, READ_TOKEN } from "./testing/fake-api";
import { connect } from "./testing/harness";
import { catalogueOf, createKnotworkingServer } from "./tools";

type Session = Awaited<ReturnType<typeof connect>>;
const open: Session[] = [];
async function session(options: Parameters<typeof connect>[0] = {}) {
  const s = await connect({ listMode: "catalogue", ...options });
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/** Raw MCP call (no harness routing), parsed. */
async function raw(s: Session, name: string, args: Record<string, unknown> = {}) {
  const result = await s.client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    // plain text
  }
  return { data, isError: result.isError === true };
}

/** What the server itself lists (the harness widens `listTools` in catalogue mode for the suites). */
async function nativeListing(s: Session) {
  const res = (await s.client.request({ method: "tools/list", params: {} }, undefined as never)) as {
    tools: { name: string }[];
  };
  return res.tools;
}

const CORE = [
  "list_workspaces",
  "get_workspace_overview",
  "search_tasks",
  "get_task",
  "create_task",
  "update_task",
  "search_documents",
  "get_document",
  "trace_lot",
  "get_distribution_impact",
  "list_modules",
  "find_records",
  "get_record",
  "describe_module",
  "run_module_tool",
];

describe("catalogue mode listing", () => {
  it("lists only the core tools, within the token budget, with every module and action on", async () => {
    const s = await session({ enable: tokenActionIds });
    const tools = await nativeListing(s);
    expect(tools.map((t) => t.name).sort()).toEqual([...CORE].sort());
    // About 4 characters per token: the default list must stay small (docs/mcp.md).
    expect(JSON.stringify(tools).length / 4).toBeLessThan(8_000);
  });

  it("lists a fraction of what ?list=all lists", async () => {
    const all = await connect({ listMode: "all", enable: tokenActionIds });
    open.push(all);
    const catalogue = await session({ enable: tokenActionIds });
    const allSize = JSON.stringify(await nativeListing(all)).length;
    const catalogueSize = JSON.stringify(await nativeListing(catalogue)).length;
    expect(catalogueSize * 10).toBeLessThan(allSize);
  });

  it("leaves out the dispatchers in ?list=all, and write tools when read-only", async () => {
    const all = await connect({ listMode: "all" });
    open.push(all);
    const names = (await nativeListing(all)).map((t) => t.name);
    expect(names).toContain("find_records");
    expect(names).not.toContain("run_module_tool");
    expect(names).not.toContain("describe_module");

    const read = await session({ readOnly: true });
    const readNames = (await nativeListing(read)).map((t) => t.name);
    expect(readNames).not.toContain("create_task");
    expect(readNames).toContain("run_module_tool");
  });

  it("tells catalogue clients how to reach module tools, and leaves out the dashboards note without bi", async () => {
    const s = await session({ modules: ["tasks", "docs", "items"] });
    expect(s.client.getInstructions()).toMatch(/describe_module/);
    expect(s.client.getInstructions()).not.toMatch(/Dashboards/);
    const all = await connect({ listMode: "all" });
    open.push(all);
    expect(all.client.getInstructions()).not.toMatch(/describe_module/);
    expect(all.client.getInstructions()).toMatch(/Dashboards/);
  });

  it("puts the module summary in the workspace overview in catalogue mode only", async () => {
    const s = await session({ modules: ["tasks", "items"] });
    const overview = await raw(s, "get_workspace_overview", { workspace: "acme" });
    const items = overview.data.modules.find((m: { id: string }) => m.id === "items");
    expect(items.resources).toEqual(expect.arrayContaining(["items", "suppliers"]));
    expect(items.tools).toContain("create_item");
    expect(items.tools).not.toContain("list_items");
    const all = await connect({ listMode: "all" });
    open.push(all);
    expect((await all.call("get_workspace_overview", { workspace: "acme" })).data.modules).toBeUndefined();
  });
});

describe("list_modules and describe_module", () => {
  it("names each module's resources and tools, only for offered modules", async () => {
    const s = await session({ modules: ["tasks", "docs", "quality"] });
    const { data } = await raw(s, "list_modules");
    expect(data.core).toEqual(expect.arrayContaining(["get_task", "search_documents"]));
    const ids = data.modules.map((m: { id: string }) => m.id);
    expect(ids).toEqual(["platform", "tasks", "docs", "quality"]);
    const quality = data.modules.find((m: { id: string }) => m.id === "quality");
    expect(quality.resources).toEqual(
      expect.arrayContaining(["complaints", "nonconformances", "quality_records"]),
    );
    expect(quality.tools).toContain("log_complaint");
    expect(quality.tools).not.toContain("list_complaints");
  });

  it("hides token-action tools until enabled, and write tools on a read-only connection", async () => {
    const off = await session();
    const stock = (await raw(off, "describe_module", { module: "stock" })).data;
    expect(stock.tools.map((t: { name: string }) => t.name)).not.toContain("record_stock_waste");
    const on = await session({ enable: ["stock.waste"] });
    const enabled = (await raw(on, "describe_module", { module: "stock" })).data;
    expect(enabled.tools.map((t: { name: string }) => t.name)).toContain("record_stock_waste");

    const read = await session({ readOnly: true });
    const items = (await raw(read, "describe_module", { module: "items" })).data;
    expect(items.tools.every((t: { readOnly: boolean }) => t.readOnly)).toBe(true);
    expect(items.tools.map((t: { name: string }) => t.name)).not.toContain("create_item");
  });

  it("gives full schemas: resource filters, get options and tool inputs", async () => {
    const s = await session();
    const { data } = await raw(s, "describe_module", { module: "items" });
    const items = data.resources.find((r: { name: string }) => r.name === "items");
    expect(items.list.tool).toBe("list_items");
    expect(Object.keys(items.list.filters.properties)).toEqual(
      expect.arrayContaining(["query", "allergen", "limit"]),
    );
    expect(items.list.filters.properties.workspace).toBeUndefined();
    expect(Object.keys(items.get.id)).toEqual(["item"]);
    const create = data.tools.find((t: { name: string }) => t.name === "create_item");
    expect(create.input.required).toEqual(expect.arrayContaining(["code", "name"]));
    // Compact, like the listing.
    expect(JSON.stringify(data)).not.toContain("[0-9a-fA-F]{8}-");
  });

  it("refuses an unknown or hidden module by naming the available ones", async () => {
    const s = await session({ modules: ["tasks", "items"] });
    const res = await raw(s, "describe_module", { module: "quality" });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe("not_found");
    expect(res.data.error.message).toContain("items");
  });
});

describe("find_records and get_record", () => {
  it("return what the resource's own tools return", async () => {
    const fake = createFakeApi();
    const all = await connect({ fake, listMode: "all" });
    open.push(all);
    const s = await session({ fake });
    expect((await raw(s, "find_records", { resource: "items", filters: { allergen: "milk" } })).data).toEqual(
      (await all.call("list_items", { allergen: "milk" })).data,
    );
    expect((await raw(s, "get_record", { resource: "items", id: "FLR-001" })).data).toEqual(
      (await all.call("get_item", { item: "FLR-001" })).data,
    );
  });

  it("returns the same as the list tool for every resource that lists without filters", async () => {
    const fake = createFakeApi();
    const all = await connect({ fake, listMode: "all", enable: tokenActionIds, defaultWorkspace: "acme" });
    open.push(all);
    const s = await session({ fake, enable: tokenActionIds, defaultWorkspace: "acme" });
    const { data } = await raw(s, "list_modules");
    let compared = 0;
    for (const m of data.modules) {
      const described = (await raw(s, "describe_module", { module: m.id })).data;
      for (const r of described.resources) {
        if (!r.list || r.list.filters.required?.length) continue;
        const viaTool = await all.call(r.list.tool);
        const viaFind = await raw(s, "find_records", { resource: r.name });
        expect(viaFind, r.name).toEqual({ data: viaTool.data, isError: viaTool.isError });
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(40);
  });

  it("passes get options through and checks them", async () => {
    const s = await session();
    const ok = await raw(s, "get_record", {
      resource: "recipes",
      id: "nope",
      options: { batches: 2 },
    });
    // The recipe doesn't exist: the call reached the tool with the option accepted.
    expect(ok.data.error.code).not.toBe("invalid_input");
    const bad = await raw(s, "get_record", { resource: "recipes", id: "x", options: { colour: "red" } });
    expect(bad.data.error).toMatchObject({ code: "invalid_input" });
    expect(bad.data.error.message).toMatch(/colour.*Accepted fields: .*batches/);
  });

  it("refuses unknown filters, naming the accepted ones, instead of ignoring them", async () => {
    const s = await session();
    const res = await raw(s, "find_records", { resource: "items", filters: { colour: "red" } });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe("invalid_input");
    expect(res.data.error.message).toMatch(/unknown field\(s\) colour.*Accepted fields: .*allergen/);
    const badValue = await raw(s, "find_records", { resource: "items", filters: { allergen: "gluten" } });
    expect(badValue.data.error.code).toBe("invalid_input");
  });

  it("refuses unknown resources and unsupported operations helpfully", async () => {
    const s = await session();
    const unknown = await raw(s, "find_records", { resource: "widgets" });
    expect(unknown.data.error.code).toBe("not_found");
    expect(unknown.data.error.message).toContain("items");
    const noGet = await raw(s, "get_record", { resource: "suppliers", id: "x" });
    expect(noGet.data.error.code).toBe("unsupported_operation");
    const noList = await raw(s, "find_records", { resource: "quality_records" });
    expect(noList.data.error.code).toBe("unsupported_operation");
  });

  it("does not offer the resources of hidden modules", async () => {
    const s = await session({ modules: ["tasks", "docs"] });
    const res = await raw(s, "find_records", { resource: "items" });
    expect(res.data.error.code).toBe("not_found");
  });
});

describe("run_module_tool", () => {
  it("runs an offered tool with its arguments checked strictly", async () => {
    const s = await session();
    const created = await raw(s, "run_module_tool", {
      name: "create_supplier",
      args: { workspace: "acme", name: "Catalogue Mill" },
    });
    expect(created.isError).toBe(false);
    expect(s.fake.itemsModule.suppliers.at(-1)?.name).toBe("Catalogue Mill");
    const extra = await raw(s, "run_module_tool", {
      name: "create_supplier",
      args: { workspace: "acme", name: "X", colour: "red" },
    });
    expect(extra.data.error.code).toBe("invalid_input");
  });

  it("answers a hidden tool exactly like a misspelt one", async () => {
    const read = await session({ readOnly: true });
    const hidden = await raw(read, "run_module_tool", { name: "create_supplier", args: {} });
    const misspelt = await raw(read, "run_module_tool", { name: "create_suplier", args: {} });
    expect(hidden.data.error.code).toBe("unknown_tool");
    expect(hidden.data.error.message.replace("create_supplier", "X")).toBe(
      misspelt.data.error.message.replace("create_suplier", "X"),
    );
    const off = await session();
    expect(
      (await raw(off, "run_module_tool", { name: "record_stock_waste", args: {} })).data.error.code,
    ).toBe("unknown_tool");
  });

  it("keeps the delete guard: a permanent delete still needs confirm: true", async () => {
    const s = await session();
    const res = await raw(s, "run_module_tool", {
      name: "delete_project",
      args: { workspace: "acme", project: "Website" },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.data)).toMatch(/confirm/);
  });

  it("is refused write tools for a read-only token by the API as before", async () => {
    const s = await session({ token: READ_TOKEN });
    const res = await raw(s, "run_module_tool", {
      name: "create_supplier",
      args: { workspace: "acme", name: "Nope" },
    });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe("token_read_only");
  });
});

/**
 * Readers that stay named tools: reports, summaries, plans and lookups that aren't a list of
 * records or one record by id. Any other `list_*` / `get_*` tool must be a resource.
 */
const SPECIALIST_READERS = new Set([
  "list_workspaces",
  "get_workspace_overview",
  "get_task_backlinks",
  "get_document_backlinks",
  "get_document_revision",
  "get_time_report",
  "list_outstanding_sop_reading",
  "get_stock_levels",
  "get_lot_qa_evidence",
  "get_workforce_availability",
  "get_rota",
  "get_staffing_check",
  "get_sales_commitments",
  "get_dashboard_data",
  "get_despatch_operations",
  "get_distribution_impact",
  "get_lot_recipients",
  "get_demand_summary",
  "get_demand_forecast",
  "get_demand_capacity",
  "get_demand_coverage",
  "get_material_requirements",
  "get_production_schedule",
  "get_production_day_plan",
  "get_production_daily_demand",
  "get_production_performance",
  "get_batch_packing",
  "get_lot_packing",
  "get_haccp_plan",
  "get_haccp_library",
  "get_haccp_due",
  "get_training_matrix",
  "list_training_due",
  "get_staff_training",
  "get_attendance_shifts",
  "get_quality_summary",
  "get_complaint_trends",
  "get_supplier_quality",
  "get_site_due",
  "get_checklists_due",
  "get_crm_pipeline",
  "get_pest_trends",
  "get_label_facts",
  "get_product_label",
  "get_testing_due",
  "get_test_trend",
  "get_supplier_controls",
  "get_food_defence_overview",
  "get_governance_overview",
  "get_gap_analysis",
  "get_attachment_link",
]);

describe("structure", () => {
  it("makes every plain list or single-record read a resource", () => {
    const server = createKnotworkingServer({
      getApi: () => {
        throw new Error("not called");
      },
      tokenActions: tokenActionIds,
    });
    const entries = [...catalogueOf(server)!.entries.values()];
    const stray = entries
      .filter((e) => /^(list|get)_/.test(e.name) && !e.resource && !SPECIALIST_READERS.has(e.name))
      .map((e) => e.name);
    expect(stray, "declare these with `resource`, or add them to SPECIALIST_READERS").toEqual([]);
    for (const name of SPECIALIST_READERS) expect(catalogueOf(server)!.entries.has(name), name).toBe(true);
  });
});
