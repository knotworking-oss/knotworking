import { describe, expect, it } from "vitest";
import { connect } from "../testing/harness";

describe("Checklists tools", () => {
  it("manages general templates independently of Site and preserves item IDs on edits", async () => {
    const { client, call, close } = await connect({ modules: ["checklists"] });
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("save_checklist_template");
      expect(names).not.toContain("get_site_due");
      expect(names).not.toContain("record_checklist_result");
      const { data: added } = await call("save_checklist_template", {
        template: {
          name: "Office close",
          frequency: { every: 1, unit: "day" },
          items: [{ prompt: "Secure the entrance" }],
        },
      });
      expect(added).toMatchObject({ name: "Office close", kind: "general", status: "active" });
      const { data: updated } = await call("save_checklist_template", {
        id: added.id,
        template: { items: [{ id: added.items[0].id, prompt: "Lock the entrance" }] },
      });
      expect(updated.items).toEqual([
        expect.objectContaining({ id: added.items[0].id, prompt: "Lock the entrance" }),
      ]);
      expect((await call("get_checklist_template", { template_id: added.id })).data).toMatchObject({
        id: added.id,
      });
      expect((await call("list_checklist_templates", {})).data.templates).toHaveLength(1);
      expect((await call("list_checklist_actions", {})).data.actions).toEqual([]);
    } finally {
      await close();
    }
  });
});
