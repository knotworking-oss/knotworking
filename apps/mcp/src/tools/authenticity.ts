import {
  authenticityCreateSchema,
  authenticityListQuerySchema,
  authenticitySaveSchema,
  authenticityTriggerSchema,
  authenticityVersionCommandSchema,
} from "@knotworking/core";
import { z } from "zod";
import { READ, type ToolContext } from "./shared";
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export function registerAuthenticityTools({ define, slugOf, workspaceParam }: ToolContext) {
  define(
    "list_authenticity_assessments",
    {
      module: "quality",
      resource: { name: "authenticity_assessments", op: "list" },
      title: "List food authenticity assessments",
      description:
        "Read recorded material/supplier food-fraud assessments, risk judgement, overdue/expired or failed controls and review triggers. Filter by item/supplier/title/reference. Recorded assessments do not establish full material coverage. Attention filters use the workspace business date; refine the search if more than 2,000 candidates match.",
      annotations: READ,
      input: { workspace: workspaceParam, ...authenticityListQuerySchema.shape },
    },
    async ({ workspace, ...query }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].quality.authenticity.$get({
          param: { slug },
          query: { ...query, limit: String(query.limit), offset: String(query.offset) },
        }),
      );
    },
  );
  define(
    "get_authenticity_assessment",
    {
      module: "quality",
      resource: { name: "authenticity_assessments", op: "get" },
      title: "Read authenticity assessment evidence",
      description:
        "Read draft/current/prior signed reviews, intelligence sources, provenance/claim references, control plans, verification evidence and corrections, and open/resolved review triggers. Linked laboratory records are opaque references and must be read through Testing's own permissions. Approval, verification, corrections and archival are signed-in people's actions in the app.",
      annotations: READ,
      input: { workspace: workspaceParam, id: z.uuid() },
    },
    async ({ workspace, id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].quality.authenticity[":id"].$get({ param: { slug, id } }),
      );
    },
  );
  define(
    "create_authenticity_draft",
    {
      module: "quality",
      title: "Create food authenticity assessment draft",
      description:
        "Create an editable item/supplier-scope assessment. One active assessment per scope; search first. Incomplete drafts are allowed. Use a stable commandId for retries. Linking a test requires Testing read access. This does not approve a supplier, sign the assessment, verify controls or change stock.",
      annotations: WRITE,
      input: { workspace: workspaceParam, ...authenticityCreateSchema.shape },
    },
    async ({ workspace, ...json }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].quality.authenticity.$post({ param: { slug }, json }),
      );
    },
  );
  define(
    "start_authenticity_review",
    {
      module: "quality",
      title: "Start the next authenticity review draft",
      description:
        "Copy the current signed assessment into the next editable revision while the current control plan continues to apply. Send expectedUpdatedAt from a fresh get and retain commandId on retries. Earlier signed content and its verification records remain immutable.",
      annotations: WRITE,
      input: { workspace: workspaceParam, id: z.uuid(), ...authenticityVersionCommandSchema.shape },
    },
    async ({ workspace, id, ...json }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].quality.authenticity[":id"].draft.$post({
          param: { slug, id },
          json,
        }),
      );
    },
  );
  define(
    "save_authenticity_draft",
    {
      module: "quality",
      title: "Save authenticity review draft",
      description:
        "Replace the complete draft body, retaining all existing evidence and controls intended to remain. Send expectedUpdatedAt from a fresh get and a stable commandId. Stale drafts are refused, including when new evidence or triggers arrived. Linked test samples require Testing read access and must belong to the same item. This tool cannot change a signed version.",
      annotations: WRITE,
      input: { workspace: workspaceParam, id: z.uuid(), ...authenticitySaveSchema.shape },
    },
    async ({ workspace, id, ...json }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].quality.authenticity[":id"].draft.$put({
          param: { slug, id },
          json,
        }),
      );
    },
  );
  define(
    "raise_authenticity_review_trigger",
    {
      module: "quality",
      title: "Record authenticity intelligence or review trigger",
      description:
        "Record a source-backed alert, source/supplier/origin change or other reason to review a material's fraud vulnerability. A manager must explicitly review all open triggers when signing a later assessment revision. This records evidence only and sends no messages; use the incident/stock workflows for containment where needed.",
      annotations: WRITE,
      input: { workspace: workspaceParam, id: z.uuid(), ...authenticityTriggerSchema.shape },
    },
    async ({ workspace, id, ...json }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].quality.authenticity[":id"].triggers.$post({
          param: { slug, id },
          json,
        }),
      );
    },
  );
}
