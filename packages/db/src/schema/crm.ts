/** CRM: leads, opportunities on configurable pipeline stages, and follow-up activities. */
import type { CrmActivityKind, CrmLeadStatus, CrmOpportunityStatus } from "@knotworking/core";
import { sql } from "drizzle-orm";
import { check, date, index, integer, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { serviceQuotes } from "./client-services";
import { customers } from "./customers";
import { pk, ts, workspaceRef } from "./helpers";
import { salesOrders } from "./sales";

/** A workspace's open pipeline stages, in order. Won and lost are outcomes on the opportunity. */
export const crmStages = pgTable(
  "crm_stages",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    /** Likelihood of winning at this stage, 0–100, for a weighted pipeline. */
    probability: integer("probability").notNull().default(0),
    archivedAt: ts("archived_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("crm_stages_workspace_name_key")
      .on(t.workspaceId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    index("crm_stages_workspace_position_idx").on(t.workspaceId, t.position),
    check("crm_stages_probability_check", sql`${t.probability} between 0 and 100`),
  ],
);

export const crmLeads = pgTable(
  "crm_leads",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    reference: text("reference").notNull(),
    /** The person to talk to. */
    name: text("name").notNull(),
    company: text("company").notNull().default(""),
    email: text("email"),
    phone: text("phone"),
    source: text("source"),
    notes: text("notes").notNull().default(""),
    status: text("status").$type<CrmLeadStatus>().notNull().default("new"),
    statusReason: text("status_reason"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    /** Set when the lead is converted: the customer of the register it became (or joined). */
    customerId: uuid("customer_id").references(() => customers.id),
    convertedAt: ts("converted_at"),
    convertedBy: uuid("converted_by").references(() => users.id, { onDelete: "set null" }),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("crm_leads_workspace_reference_key").on(t.workspaceId, t.reference),
    index("crm_leads_workspace_status_idx").on(t.workspaceId, t.status, t.id),
    index("crm_leads_workspace_owner_idx").on(t.workspaceId, t.ownerId, t.id),
    check(
      "crm_leads_status_check",
      sql`${t.status} in ('new', 'contacted', 'qualified', 'converted', 'disqualified')`,
    ),
    check(
      "crm_leads_converted_check",
      sql`(${t.status} = 'converted') = (${t.customerId} is not null and ${t.convertedAt} is not null)`,
    ),
  ],
);

export const crmOpportunities = pgTable(
  "crm_opportunities",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    customerId: uuid("customer_id").references(() => customers.id),
    leadId: uuid("lead_id").references(() => crmLeads.id),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => crmStages.id),
    status: text("status").$type<CrmOpportunityStatus>().notNull().default("open"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    value: numeric("value", { precision: 14, scale: 2, mode: "number" }),
    currency: text("currency").notNull(),
    expectedCloseDate: date("expected_close_date"),
    notes: text("notes").notNull().default(""),
    /** The quote it is linked to in Sales or Client services (soft dependencies). */
    salesQuoteId: uuid("sales_quote_id").references(() => salesOrders.id),
    serviceQuoteId: uuid("service_quote_id").references(() => serviceQuotes.id),
    closedAt: ts("closed_at"),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    closedReason: text("closed_reason"),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("crm_opportunities_workspace_reference_key").on(t.workspaceId, t.reference),
    // A quote backs one opportunity.
    uniqueIndex("crm_opportunities_sales_quote_key")
      .on(t.workspaceId, t.salesQuoteId)
      .where(sql`${t.salesQuoteId} is not null`),
    uniqueIndex("crm_opportunities_service_quote_key")
      .on(t.workspaceId, t.serviceQuoteId)
      .where(sql`${t.serviceQuoteId} is not null`),
    index("crm_opportunities_workspace_status_idx").on(t.workspaceId, t.status, t.stageId, t.id),
    index("crm_opportunities_workspace_customer_idx").on(t.workspaceId, t.customerId),
    index("crm_opportunities_workspace_lead_idx").on(t.workspaceId, t.leadId),
    check("crm_opportunities_status_check", sql`${t.status} in ('open', 'won', 'lost')`),
    check("crm_opportunities_party_check", sql`${t.customerId} is not null or ${t.leadId} is not null`),
    check("crm_opportunities_value_check", sql`${t.value} is null or ${t.value} >= 0`),
    check("crm_opportunities_closed_check", sql`(${t.status} = 'open') = (${t.closedAt} is null)`),
  ],
);

/** Calls, emails, meetings and to-dos on a lead or an opportunity; a due date makes one a follow-up. */
export const crmActivities = pgTable(
  "crm_activities",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    leadId: uuid("lead_id").references(() => crmLeads.id),
    opportunityId: uuid("opportunity_id").references(() => crmOpportunities.id),
    kind: text("kind").$type<CrmActivityKind>().notNull(),
    subject: text("subject").notNull(),
    notes: text("notes").notNull().default(""),
    dueOn: date("due_on"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    completedAt: ts("completed_at"),
    completedBy: uuid("completed_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("crm_activities_workspace_lead_idx").on(t.workspaceId, t.leadId),
    index("crm_activities_workspace_opportunity_idx").on(t.workspaceId, t.opportunityId),
    index("crm_activities_workspace_due_idx").on(t.workspaceId, t.ownerId, t.dueOn),
    check("crm_activities_subject_check", sql`(${t.leadId} is null) <> (${t.opportunityId} is null)`),
    check("crm_activities_kind_check", sql`${t.kind} in ('call', 'email', 'meeting', 'task', 'note')`),
  ],
);
