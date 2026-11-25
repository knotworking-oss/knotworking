import { describe, expect, it } from "vitest";
import {
  crmActivityCreateSchema,
  crmLeadUpdateSchema,
  crmOpportunityCreateSchema,
  crmStagesSaveSchema,
  defaultCrmStages,
} from "./crm";
import { modules } from "./modules";
import { describeNotification, notificationPath } from "./notifications";

const id = "0190a000-0000-7000-8000-000000000001";

describe("CRM", () => {
  it("is an opt-in module on Customers, enhanced by Sales and Client services", () => {
    expect(modules.crm).toMatchObject({
      dependsOn: ["customers"],
      enhancedBy: ["sales", "client_services"],
      defaultAccess: "none",
    });
    expect(defaultCrmStages.map((s) => s.probability)).toEqual([10, 25, 50, 75]);
  });

  it("needs a reason to disqualify a lead", () => {
    expect(crmLeadUpdateSchema.safeParse({ expectedRevision: 1, status: "disqualified" }).success).toBe(
      false,
    );
    expect(
      crmLeadUpdateSchema.safeParse({
        expectedRevision: 1,
        status: "disqualified",
        statusReason: "No budget",
      }).success,
    ).toBe(true);
  });

  it("needs a customer or a lead on an opportunity, and rounds its value to the cent", () => {
    const base = { commandId: id, title: "Retainer", currency: "GBP" };
    expect(crmOpportunityCreateSchema.safeParse(base).success).toBe(false);
    expect(crmOpportunityCreateSchema.parse({ ...base, leadId: id, value: 10.005 })).toMatchObject({
      value: 10.01,
      customerId: null,
      salesQuoteId: null,
      serviceQuoteId: null,
    });
  });

  it("attaches an activity to exactly one lead or opportunity", () => {
    const base = { commandId: id, kind: "call", subject: "Check in" };
    expect(crmActivityCreateSchema.safeParse(base).success).toBe(false);
    expect(crmActivityCreateSchema.safeParse({ ...base, leadId: id, opportunityId: id }).success).toBe(false);
    expect(crmActivityCreateSchema.parse({ ...base, leadId: id })).toMatchObject({
      done: false,
      dueOn: null,
    });
  });

  it("refuses duplicate stage names whatever their case", () => {
    const stages = [
      { name: "Proposal", probability: 50 },
      { name: "proposal", probability: 60 },
    ];
    expect(crmStagesSaveSchema.safeParse({ stages }).success).toBe(false);
  });

  it("links follow-up notifications to their lead or opportunity", () => {
    const data = {
      title: "Call back (Rivers Studio)",
      subjectId: id,
      crmRecord: "lead" as const,
      dueOn: "2026-12-01",
    };
    expect(notificationPath({ type: "crm_follow_up_due", data })).toBe(`/crm/leads/${id}`);
    expect(
      notificationPath({ type: "crm_follow_up_assigned", data: { ...data, crmRecord: "opportunity" } }),
    ).toBe(`/crm/opportunities/${id}`);
    expect(notificationPath({ type: "crm_follow_up_due", data: {} })).toBe("/crm/follow-ups");
    expect(describeNotification("crm_follow_up_due", "", { ...data, dueState: "overdue" })).toBe(
      "Follow-up Call back (Rivers Studio) is overdue (since 2026-12-01)",
    );
  });
});
