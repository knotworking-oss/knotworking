import { describe, expect, it } from "vitest";
import { connect } from "../testing/harness";

describe("CRM tools", () => {
  it("works a lead into a won opportunity and offers no handoff tool", async () => {
    const { client, call, close } = await connect({ modules: ["customers", "crm"] });
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["save_crm_lead", "record_crm_outcome", "get_crm_pipeline"]));
      expect(names.filter((name) => /handoff|hand_off/.test(name))).toEqual([]);
      // Without Sales or Client services there are no quote tools to link from.
      expect(names).not.toContain("draft_sales_document");
      expect(names).not.toContain("list_service_quotes");

      const { data: lead } = await call("save_crm_lead", { lead: { name: "Jo Rivers", company: "Rivers Studio" } });
      expect(lead).toMatchObject({ status: "new", revision: 1 });
      const { data: qualified } = await call("save_crm_lead", {
        lead_id: lead.id,
        lead: { expectedRevision: 1, status: "qualified" },
      });
      const { data: opportunity } = await call("save_crm_opportunity", {
        opportunity: { title: "Workflow review", leadId: lead.id, currency: "GBP", value: 1800 },
      });
      expect(opportunity.stage).toMatchObject({ name: "Qualification" });
      const { data: converted } = await call("convert_crm_lead", {
        lead_id: lead.id,
        expected_revision: qualified.revision,
        customer: { mode: "new", code: "RIV", name: "Rivers Studio", address: "4 Mill Lane" },
      });
      expect(converted.status).toBe("converted");
      const { data: followUp } = await call("save_crm_follow_up", {
        activity: { opportunityId: opportunity.id, kind: "call", subject: "Check the proposal", dueOn: "2026-11-30" },
      });
      expect((await call("list_crm_follow_ups", {})).data.activities).toEqual([
        expect.objectContaining({ id: followUp.id }),
      ]);
      const { data: won } = await call("record_crm_outcome", {
        opportunity_id: opportunity.id,
        expected_revision: opportunity.revision,
        outcome: "won",
        reason: "Accepted",
      });
      expect(won).toMatchObject({ status: "won", closedReason: "Accepted" });
      expect((await call("get_crm_pipeline", {})).data.won.count).toBe(1);
      expect((await call("get_crm_opportunity", { opportunity_id: opportunity.id })).data.id).toBe(opportunity.id);
      expect((await call("list_crm_leads", { status: "converted" })).data.leads).toHaveLength(1);
      // Invalid input is refused before the API is called.
      const bad = await call("save_crm_opportunity", { opportunity: { title: "No party", currency: "GBP" } });
      expect(bad.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("reaches CRM records through the catalogue", async () => {
    const session = await connect({ modules: ["customers", "crm"], listMode: "catalogue" });
    try {
      const created = await session.call("save_crm_lead", { lead: { name: "Lee Park" } });
      expect(created.isError).toBe(false);
      const detail = await session.call("get_crm_lead", { lead_id: created.data.id });
      expect(detail.data).toMatchObject({ id: created.data.id, opportunities: [], activities: [] });
    } finally {
      await session.close();
    }
  });
});
