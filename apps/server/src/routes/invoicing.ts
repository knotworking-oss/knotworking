import {
  invoiceDecisionSchema,
  invoiceDraftSchema,
  invoiceEditSchema,
  invoiceListSchema,
  invoiceSourceModules,
  invoicingSettingsSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { assertModule, requireModuleLevel } from "../middleware/modules";
import { customerDocumentPdf } from "../services/invoice-pdf";
import {
  decideCustomerDocument,
  draftCustomerDocument,
  editCustomerDocument,
  findCustomerDocument,
  getCustomerDocument,
  getInvoicingSettings,
  listCustomerDocuments,
  saveInvoicingSettings,
} from "../services/invoicing";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });

export const invoicingRoutes = new Hono<WorkspaceEnv>()
  .get("/invoicing", validate("query", invoiceListSchema), async (c) =>
    c.json(await listCustomerDocuments(c.var.db, c.var.workspace.id, c.req.valid("query").offset)),
  )
  .post("/invoicing", validate("json", invoiceDraftSchema), async (c) => {
    const input = c.req.valid("json");
    const useDespatch = c.var.activeModules.includes("despatch");
    if (input.kind !== "manual" && input.kind !== "credit") {
      assertModule(c, invoiceSourceModules[input.kind], "read");
      if (input.kind === "sales" && useDespatch) assertModule(c, "despatch", "read");
    }
    return c.json(
      await draftCustomerDocument(c.var.db, c.var.workspace.id, c.var.user.id, input, useDespatch),
      201,
    );
  })
  .get("/invoicing/settings", async (c) => c.json(await getInvoicingSettings(c.var.db, c.var.workspace.id)))
  .put(
    "/invoicing/settings",
    requireModuleLevel("invoicing", "manage"),
    forbidTokens,
    validate("json", invoicingSettingsSchema),
    async (c) =>
      c.json(await saveInvoicingSettings(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"))),
  )
  .get("/invoicing/:id", validate("param", idParam), async (c) => {
    return c.json(await getCustomerDocument(c.var.db, c.var.workspace.id, c.req.valid("param").id));
  })
  .patch("/invoicing/:id", validate("param", idParam), validate("json", invoiceEditSchema), async (c) =>
    c.json(
      await editCustomerDocument(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  )
  .post(
    "/invoicing/:id/decision",
    requireModuleLevel("invoicing", "manage"),
    forbidTokens,
    validate("param", idParam),
    validate("json", invoiceDecisionSchema),
    async (c) =>
      c.json(
        await decideCustomerDocument(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .get("/invoicing/:id/pdf", validate("param", idParam), async (c) => {
    const doc = await findCustomerDocument(c.var.db, c.var.workspace.id, c.req.valid("param").id);
    const pdf = await customerDocumentPdf(doc);
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `attachment; filename="${doc.number}.pdf"`);
    c.header("Cache-Control", "private, no-store");
    return c.body(new Uint8Array(pdf));
  });
