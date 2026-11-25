import {
  crmActivityCreateSchema,
  crmActivityListSchema,
  crmActivityUpdateSchema,
  crmHandoffSchema,
  crmLeadConvertSchema,
  crmLeadCreateSchema,
  crmLeadListSchema,
  crmLeadUpdateSchema,
  crmOpportunityCreateSchema,
  crmOpportunityListSchema,
  crmOpportunityUpdateSchema,
  crmOutcomeSchema,
  crmStagesSaveSchema,
} from "@knotworking/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { assertModule, canRead, requireModuleLevel } from "../middleware/modules";
import {
  convertCrmLead,
  createCrmActivity,
  createCrmLead,
  createCrmOpportunity,
  crmPipeline,
  crmQuoteOptions,
  decideCrmOutcome,
  getCrmLead,
  getCrmOpportunity,
  handOffCrmOpportunity,
  listCrmActivities,
  listCrmLeads,
  listCrmOpportunities,
  listCrmStages,
  saveCrmStages,
  updateCrmActivity,
  updateCrmLead,
  updateCrmOpportunity,
  type CrmLinks,
} from "../services/crm";
import { emailNotifier } from "../services/notifications";
import { validate } from "../validate";

const id = z.object({ id: z.uuid() });

/** The soft dependencies the caller can read: linked quotes, orders and projects resolve only then. */
const linksOf = (c: Context<WorkspaceEnv>): CrmLinks => ({
  sales: canRead(c, "sales"),
  services: canRead(c, "client_services"),
  tasks: canRead(c, "tasks"),
});

/** Linking a quote needs read access to the module that owns it (`404 module_inactive` when it is off). */
function assertQuoteAccess(
  c: Context<WorkspaceEnv>,
  input: { salesQuoteId?: string | null; serviceQuoteId?: string | null },
) {
  if (input.salesQuoteId) assertModule(c, "sales", "read");
  if (input.serviceQuoteId) assertModule(c, "client_services", "read");
}

export const crmRoutes = new Hono<WorkspaceEnv>()
  // Pipeline stages: any CRM reader sees them, managers change them.
  .get("/crm/stages", async (c) => c.json(await listCrmStages(c.var.db, c.var.workspace.id, c.var.user.id)))
  .put("/crm/stages", requireModuleLevel("crm", "manage"), validate("json", crmStagesSaveSchema), async (c) =>
    c.json(await saveCrmStages(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"))),
  )
  .get("/crm/pipeline", validate("query", z.object({ ownerId: z.uuid().optional() })), async (c) =>
    c.json(await crmPipeline(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("query"), linksOf(c))),
  )
  // Leads.
  .get("/crm/leads", validate("query", crmLeadListSchema), async (c) =>
    c.json(await listCrmLeads(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/crm/leads", validate("json", crmLeadCreateSchema), async (c) =>
    c.json(
      await createCrmLead(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.var.activeModules,
        c.req.valid("json"),
      ),
      201,
    ),
  )
  .get("/crm/leads/:id", validate("param", id), async (c) =>
    c.json(await getCrmLead(c.var.db, c.var.workspace.id, c.req.valid("param").id, linksOf(c))),
  )
  .patch("/crm/leads/:id", validate("param", id), validate("json", crmLeadUpdateSchema), async (c) =>
    c.json(
      await updateCrmLead(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.var.activeModules,
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  )
  .post(
    "/crm/leads/:id/convert",
    validate("param", id),
    validate("json", crmLeadConvertSchema),
    async (c) => {
      const input = c.req.valid("json");
      // A new customer is a write to the shared register; linking to an existing one only reads it.
      if (input.customer.mode === "new") assertModule(c, "customers", "write");
      return c.json(
        await convertCrmLead(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id, input),
      );
    },
  )
  // Opportunities.
  .get("/crm/opportunities", validate("query", crmOpportunityListSchema), async (c) =>
    c.json(await listCrmOpportunities(c.var.db, c.var.workspace.id, c.req.valid("query"), linksOf(c))),
  )
  .post("/crm/opportunities", validate("json", crmOpportunityCreateSchema), async (c) => {
    const input = c.req.valid("json");
    assertQuoteAccess(c, input);
    return c.json(
      await createCrmOpportunity(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.var.activeModules,
        input,
        linksOf(c),
      ),
      201,
    );
  })
  .get("/crm/opportunities/:id", validate("param", id), async (c) =>
    c.json(await getCrmOpportunity(c.var.db, c.var.workspace.id, c.req.valid("param").id, linksOf(c))),
  )
  .patch(
    "/crm/opportunities/:id",
    validate("param", id),
    validate("json", crmOpportunityUpdateSchema),
    async (c) => {
      const input = c.req.valid("json");
      assertQuoteAccess(c, input);
      return c.json(
        await updateCrmOpportunity(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.var.activeModules,
          c.req.valid("param").id,
          input,
          linksOf(c),
        ),
      );
    },
  )
  .get("/crm/opportunities/:id/quote-options", validate("param", id), async (c) =>
    c.json(await crmQuoteOptions(c.var.db, c.var.workspace.id, c.req.valid("param").id, linksOf(c))),
  )
  .post(
    "/crm/opportunities/:id/outcome",
    validate("param", id),
    validate("json", crmOutcomeSchema),
    async (c) =>
      c.json(
        await decideCrmOutcome(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          linksOf(c),
        ),
      ),
  )
  .post(
    "/crm/opportunities/:id/handoff",
    forbidTokens,
    validate("param", id),
    validate("json", crmHandoffSchema),
    async (c) => {
      const input = c.req.valid("json");
      // The same access the order conversion or quote acceptance needs in its own module.
      if (input.kind === "sales_order") assertModule(c, "sales", "manage");
      else {
        assertModule(c, "client_services", "manage");
        assertModule(c, "tasks", "write");
      }
      return c.json(
        await handOffCrmOpportunity(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          input,
          linksOf(c),
        ),
      );
    },
  )
  // Activities and follow-ups.
  .get("/crm/activities", validate("query", crmActivityListSchema), async (c) =>
    c.json(await listCrmActivities(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("query"))),
  )
  .post("/crm/activities", validate("json", crmActivityCreateSchema), async (c) =>
    c.json(
      await createCrmActivity(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.var.activeModules,
        c.req.valid("json"),
        emailNotifier(c.var),
      ),
      201,
    ),
  )
  .patch("/crm/activities/:id", validate("param", id), validate("json", crmActivityUpdateSchema), async (c) =>
    c.json(
      await updateCrmActivity(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.var.activeModules,
        c.req.valid("param").id,
        c.req.valid("json"),
        emailNotifier(c.var),
      ),
    ),
  );
