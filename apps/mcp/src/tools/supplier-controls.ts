import { supplierControlLabels } from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERSON_NOTE =
  "Risk assessments (which decide the controls a supplier is held to) and accepting or rejecting a questionnaire are a person's decisions in the Knotworking app; there are no tools for them.";

/** Supplier controls (Items module): compliance, risk assessments and questionnaires. */
export function registerSupplierControlTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];

  async function resolveSupplierId(api: Api, slug: string, ref: string) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { suppliers } = await api.call(ws(api).suppliers.$get({ param: { slug }, query: { q: wanted } }));
    const lower = wanted.toLowerCase();
    const match = suppliers.filter((s) => s.code?.toLowerCase() === lower || s.name.toLowerCase() === lower);
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      match.length ? "ambiguous" : "not_found",
      match.length
        ? `More than one supplier matches "${wanted}"; pass its id.`
        : `No supplier is called "${wanted}". Use list_suppliers.`,
    );
  }

  define(
    "list_supplier_compliance",
    {
      module: "items",
      resource: { name: "supplier_compliance", op: "list" },
      title: "List supplier compliance",
      description:
        "Every supplier and service provider with its highest current risk level and the control issues to act on: no risk assessment, items bought without one, assessments due or overdue for review, required controls missing or expiring (certification, an accepted questionnaire, an approved specification), approval reviews overdue and questionnaires not returned. Those needing action first.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        only_issues: z.boolean().optional().describe("True: only suppliers with an issue."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const { suppliers, today } = await api.call(ws(api).suppliers.compliance.$get({ param: { slug } }));
      return {
        today,
        suppliers: suppliers
          .filter((s) => !a.only_issues || s.issues.length > 0)
          .map((s) => ({
            name: s.name,
            code: s.code,
            category: s.category,
            approvalStatus: s.approvalStatus,
            riskLevel: s.riskLevel,
            actions: s.actionCount,
            issues: s.issues.map((i) => `${i.severity === "action" ? "ACTION" : "warning"}: ${i.message}`),
          })),
        note: PERSON_NOTE,
      };
    },
  );

  define(
    "get_supplier_controls",
    {
      module: "items",
      title: "Get supplier controls",
      description:
        "One supplier's current risk assessments (item or whole supplier, risk level, hazards, rationale, review date) with each required control and whether the evidence meets it, earlier assessments, questionnaires, and the issues to act on.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        supplier: z.string().min(1).max(200).describe("Supplier id, exact code or exact name."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveSupplierId(api, slug, a.supplier);
      const c = await api.call(ws(api).suppliers[":id"].controls.$get({ param: { slug, id } }));
      return {
        category: c.category,
        serviceType: c.serviceType,
        riskLevel: c.riskLevel,
        issues: c.issues.map((i) => `${i.severity === "action" ? "ACTION" : "warning"}: ${i.message}`),
        assessments: c.assessments.map((x) => ({
          item: x.itemCode ?? "whole supplier",
          riskLevel: x.riskLevel,
          hazards: x.hazards,
          rationale: x.rationale,
          reviewDueOn: x.reviewDueOn,
          assessedBy: x.assessedByName,
          controls: x.controlStates.map((s) => ({
            control: supplierControlLabels[s.control],
            state: s.state,
            detail: s.detail,
          })),
        })),
        earlierAssessments: c.history.filter((h) => h.supersededAt).length,
        questionnaires: c.questionnaires.map((q) => ({
          id: q.id,
          title: q.title,
          status: q.status,
          sentOn: q.sentOn,
          receivedOn: q.receivedOn,
          validUntil: q.validUntil,
        })),
        note: PERSON_NOTE,
      };
    },
  );

  define(
    "log_supplier_questionnaire",
    {
      module: "items",
      title: "Log supplier questionnaire",
      description: `Records a self-assessment questionnaire sent to a supplier (\`title\`, \`sent_on\`), or marks one received: pass \`questionnaire\` (its id from get_supplier_controls) with \`received_on\`. ${PERSON_NOTE}`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        supplier: z.string().min(1).max(200).describe("Supplier id, exact code or exact name."),
        questionnaire: z.string().uuid().optional().describe("An existing questionnaire to mark received."),
        title: z.string().min(1).max(200).optional(),
        sent_on: z.string().date().optional(),
        received_on: z.string().date().optional(),
        notes: z.string().max(2000).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveSupplierId(api, slug, a.supplier);
      if (a.questionnaire) {
        if (!a.received_on)
          throw new ToolError("invalid_input", "Give `received_on` to mark a questionnaire received.");
        return api.call(
          ws(api).suppliers[":id"].questionnaires[":questionnaireId"].receive.$post({
            param: { slug, id, questionnaireId: a.questionnaire },
            json: { receivedOn: a.received_on, ...(a.notes ? { notes: a.notes } : {}) },
          }),
        );
      }
      if (!a.title || !a.sent_on)
        throw new ToolError("invalid_input", "Give `title` and `sent_on` for a new questionnaire.");
      return api.call(
        ws(api).suppliers[":id"].questionnaires.$post({
          param: { slug, id },
          json: {
            title: a.title,
            sentOn: a.sent_on,
            ...(a.received_on ? { receivedOn: a.received_on } : {}),
            ...(a.notes ? { notes: a.notes } : {}),
          },
        }),
      );
    },
  );
}
