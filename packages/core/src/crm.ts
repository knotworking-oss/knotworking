import { z } from "zod";
import { customerCreateSchema } from "./customers";
import { currencySchema } from "./currency";

/**
 * CRM (`crm`): leads, opportunities on a workspace's pipeline stages, owners and follow-up
 * activities, on top of the shared Customers register. Quotes stay in Sales and Client services:
 * an opportunity links to one of their quotes and hands off to the order or delivery project
 * those modules create. See docs/modules.md#crm-module.
 */

export const crmLeadStatuses = ["new", "contacted", "qualified", "converted", "disqualified"] as const;
export type CrmLeadStatus = (typeof crmLeadStatuses)[number];
export const crmLeadStatusLabels = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  converted: "Converted",
  disqualified: "Disqualified",
} satisfies Record<CrmLeadStatus, string>;
/** Statuses a person sets by editing a lead. `converted` is only reached by converting it. */
export const crmLeadEditableStatuses = ["new", "contacted", "qualified", "disqualified"] as const;

export const crmOpportunityStatuses = ["open", "won", "lost"] as const;
export type CrmOpportunityStatus = (typeof crmOpportunityStatuses)[number];
export const crmOpportunityStatusLabels = {
  open: "Open",
  won: "Won",
  lost: "Lost",
} satisfies Record<CrmOpportunityStatus, string>;

export const crmActivityKinds = ["call", "email", "meeting", "task", "note"] as const;
export type CrmActivityKind = (typeof crmActivityKinds)[number];
export const crmActivityKindLabels = {
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  task: "To do",
  note: "Note",
} satisfies Record<CrmActivityKind, string>;

/** The stages a workspace starts with. Won and lost are outcomes, not stages. */
export const defaultCrmStages: readonly { name: string; probability: number }[] = [
  { name: "Qualification", probability: 10 },
  { name: "Needs analysis", probability: 25 },
  { name: "Proposal", probability: 50 },
  { name: "Negotiation", probability: 75 },
];
export const CRM_MAX_STAGES = 12;

/** What a won opportunity hands off to: an order from Sales or a delivery project from Client services. */
export const crmHandoffKinds = ["sales_order", "service_project"] as const;
export type CrmHandoffKind = (typeof crmHandoffKinds)[number];

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const notes = z.string().trim().max(4000);
const email = z
  .union([z.email().max(254), z.literal("")])
  .transform((v) => v || null)
  .nullable();
const command = { commandId: z.uuid() };
const revision = { expectedRevision: z.number().int().positive() };
const reason = text(2000);

const leadFields = z.object({
  name: text(160),
  company: z.string().trim().max(160).default(""),
  email: email.default(null),
  phone: optionalText(80).default(null),
  source: optionalText(80).default(null),
  notes: notes.default(""),
  ownerId: z.uuid().nullable().default(null),
});
export const crmLeadCreateSchema = leadFields.extend(command);
export const crmLeadUpdateSchema = z
  .object({
    ...revision,
    name: text(160).optional(),
    company: z.string().trim().max(160).optional(),
    email: email.optional(),
    phone: optionalText(80).optional(),
    source: optionalText(80).optional(),
    notes: notes.optional(),
    ownerId: z.uuid().nullable().optional(),
    status: z.enum(crmLeadEditableStatuses).optional(),
    /** Why the lead was disqualified (required when disqualifying). */
    statusReason: optionalText(2000).optional(),
  })
  .refine((v) => v.status !== "disqualified" || Boolean(v.statusReason), {
    path: ["statusReason"],
    message: "Give a reason for disqualifying this lead",
  });
export const crmLeadConvertSchema = z.object({
  ...command,
  ...revision,
  /** A new customer for the register, or an existing one the lead belongs to. */
  customer: z.discriminatedUnion("mode", [
    customerCreateSchema.omit({ status: true }).extend({ mode: z.literal("new") }),
    z.object({ mode: z.literal("existing"), customerId: z.uuid() }),
  ]),
});
export const crmLeadListSchema = z.object({
  status: z.enum(crmLeadStatuses).optional(),
  ownerId: z.uuid().optional(),
  q: z.string().trim().max(200).optional(),
  before: z.uuid().optional(),
});

const amount = z
  .number()
  .finite()
  .min(0)
  .max(9_999_999_999)
  .transform((v) => Math.round(v * 100) / 100);
const opportunityFields = z.object({
  title: text(160),
  customerId: z.uuid().nullable().default(null),
  leadId: z.uuid().nullable().default(null),
  /** Omit for the first stage of the pipeline. */
  stageId: z.uuid().optional(),
  ownerId: z.uuid().nullable().default(null),
  value: amount.nullable().default(null),
  currency: currencySchema,
  expectedCloseDate: z.iso.date().nullable().default(null),
  notes: notes.default(""),
  /** A quote in Sales (`kind: quote`) for the same customer. Needs Sales read access. */
  salesQuoteId: z.uuid().nullable().default(null),
  /** A Client services quote for the same customer. Needs Client services read access. */
  serviceQuoteId: z.uuid().nullable().default(null),
});
const oneParty = (v: { customerId?: string | null; leadId?: string | null }) =>
  Boolean(v.customerId) || Boolean(v.leadId);
export const crmOpportunityCreateSchema = opportunityFields.extend(command).refine(oneParty, {
  path: ["customerId"],
  message: "Choose a customer or a lead",
});
export const crmOpportunityUpdateSchema = z
  .object({
    ...revision,
    title: text(160).optional(),
    customerId: z.uuid().nullable().optional(),
    stageId: z.uuid().optional(),
    ownerId: z.uuid().nullable().optional(),
    value: amount.nullable().optional(),
    currency: currencySchema.optional(),
    expectedCloseDate: z.iso.date().nullable().optional(),
    notes: notes.optional(),
    salesQuoteId: z.uuid().nullable().optional(),
    serviceQuoteId: z.uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 1, "Pass at least one field to change");
export const crmOutcomeSchema = z.object({
  ...command,
  ...revision,
  /** `reopen` puts a closed opportunity back on its stage (a correction). */
  outcome: z.enum(["won", "lost", "reopen"]),
  reason,
});
export const crmHandoffSchema = z.discriminatedUnion("kind", [
  z.object({ ...command, kind: z.literal("sales_order"), reason }),
  z.object({
    ...command,
    kind: z.literal("service_project"),
    reason,
    teamId: z.uuid(),
    leadId: z.uuid(),
  }),
]);
export const crmOpportunityListSchema = z.object({
  status: z.enum([...crmOpportunityStatuses, "all"]).default("open"),
  stageId: z.uuid().optional(),
  ownerId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  leadId: z.uuid().optional(),
  before: z.uuid().optional(),
});

export const crmStagesSaveSchema = z
  .object({
    stages: z
      .array(
        z.object({
          id: z.uuid().optional(),
          name: text(80),
          probability: z.number().int().min(0).max(100),
        }),
      )
      .min(1)
      .max(CRM_MAX_STAGES),
  })
  .refine(
    (v) => new Set(v.stages.map((s) => s.name.toLowerCase())).size === v.stages.length,
    "Stage names must be unique",
  );

const activityFields = z.object({
  kind: z.enum(crmActivityKinds),
  subject: text(160),
  notes: notes.default(""),
  /** A follow-up's due date in the workspace's calendar; null for a logged activity. */
  dueOn: z.iso.date().nullable().default(null),
  /** Who follows up (default: the person creating it). */
  ownerId: z.uuid().nullable().optional(),
});
export const crmActivityCreateSchema = activityFields
  .extend({
    ...command,
    leadId: z.uuid().nullable().default(null),
    opportunityId: z.uuid().nullable().default(null),
    /** Log something already done (a call made) rather than plan a follow-up. */
    done: z.boolean().default(false),
  })
  .refine((v) => Boolean(v.leadId) !== Boolean(v.opportunityId), {
    path: ["leadId"],
    message: "Attach the activity to one lead or one opportunity",
  });
export const crmActivityUpdateSchema = z
  .object({
    kind: z.enum(crmActivityKinds).optional(),
    subject: text(160).optional(),
    notes: notes.optional(),
    dueOn: z.iso.date().nullable().optional(),
    ownerId: z.uuid().nullable().optional(),
    done: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Pass at least one field to change");
export const crmActivityListSchema = z.object({
  leadId: z.uuid().optional(),
  opportunityId: z.uuid().optional(),
  /** `mine`: follow-ups owned by the caller. */
  owner: z.enum(["mine", "all"]).default("all"),
  status: z.enum(["open", "done", "all"]).default("open"),
  /** Only follow-ups due on or before this date. */
  dueBy: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CrmLeadCreateInput = z.infer<typeof crmLeadCreateSchema>;
export type CrmLeadUpdateInput = z.infer<typeof crmLeadUpdateSchema>;
export type CrmLeadConvertInput = z.infer<typeof crmLeadConvertSchema>;
export type CrmLeadListQuery = z.infer<typeof crmLeadListSchema>;
export type CrmOpportunityCreateInput = z.infer<typeof crmOpportunityCreateSchema>;
export type CrmOpportunityUpdateInput = z.infer<typeof crmOpportunityUpdateSchema>;
export type CrmOutcomeInput = z.infer<typeof crmOutcomeSchema>;
export type CrmHandoffInput = z.infer<typeof crmHandoffSchema>;
export type CrmOpportunityListQuery = z.infer<typeof crmOpportunityListSchema>;
export type CrmStagesSaveInput = z.infer<typeof crmStagesSaveSchema>;
export type CrmActivityCreateInput = z.infer<typeof crmActivityCreateSchema>;
export type CrmActivityUpdateInput = z.infer<typeof crmActivityUpdateSchema>;
export type CrmActivityListQuery = z.infer<typeof crmActivityListSchema>;
