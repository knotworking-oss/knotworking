import {
  customerCreateSchema,
  customerListQuerySchema,
  customerUpdateSchema,
  despatchDraftSchema,
  despatchImpactQuerySchema,
  despatchListQuerySchema,
  despatchRecipientQuerySchema,
} from "@knotworking/core";
import { z } from "zod";
import { READ, type ToolContext } from "./shared";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export function registerDespatchTools({ define, slugOf, workspaceParam }: ToolContext) {
  define(
    "list_customer_delivery_sites",
    {
      module: "customers",
      resource: { name: "delivery_sites", op: "list" },
      title: "List customer delivery sites",
      description:
        "Read each customer delivery address and recall contact, including archived sites. Confirmed despatches retain their historical site details.",
      annotations: READ,
      input: { workspace: workspaceParam, customer_id: z.uuid() },
    },
    async ({ workspace, customer_id: id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(api.client.v1.workspaces[":slug"].customers[":id"].sites.$get({ param: { slug, id } }));
    },
  );
  define(
    "get_despatch_operations",
    {
      module: "despatch",
      title: "Read distribution evidence",
      description:
        "Read current and superseded handling units/SSCCs, signed allocation and load history, cumulative delivery proof and physical customer return receipts. Returns create separate quarantine lots; off-site recall dispositions are separate evidence. All physical sign-offs remain a signed-in person's action; this tool changes no stock.",
      annotations: READ,
      input: { workspace: workspaceParam, despatch_id: z.uuid() },
    },
    async ({ workspace, despatch_id: id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].despatch[":id"].operations.$get({ param: { slug, id } }),
      );
    },
  );
  define(
    "get_distribution_impact",
    {
      module: "despatch",
      pinned: true,
      requiresModules: ["production"],
      title: "Trace distribution impact",
      description:
        "Follow a lot forward through net production records and recorded physical customer-return links to affected output lots and confirmed customer delivery lines. Requires readable Despatch and Production. Coverage describes recorded data only: heed partial reasons, open/missing-output batches and depth/resource limits, even when no deliveries were found. Counts are deduplicated; quantities remain whole delivery quantities in each product's own unit. Delivery lines are paginated with total and offset. No stock or recall case is changed.",
      annotations: READ,
      input: { workspace: workspaceParam, lot_id: z.uuid(), ...despatchImpactQuerySchema.shape },
    },
    async ({ workspace, lot_id: lotId, depth, limit, offset }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].despatch.lots[":lotId"].impact.$get({
          param: { slug, lotId },
          query: { depth: String(depth), limit: String(limit), offset: String(offset) },
        }),
      );
    },
  );

  define(
    "list_customers",
    {
      module: "customers",
      resource: { name: "customers", op: "list" },
      title: "List customers",
      description:
        "Find customer accounts, business addresses and contacts by code or name. Paged; increase offset while total exceeds returned rows.",
      annotations: READ,
      input: { workspace: workspaceParam, ...customerListQuerySchema.shape },
    },
    async ({ workspace, ...q }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].customers.$get({
          param: { slug },
          query: { ...q, limit: String(q.limit), offset: String(q.offset) },
        }),
      );
    },
  );
  define(
    "create_customer",
    {
      module: "customers",
      title: "Create customer",
      description:
        "Create a customer account. Search first to avoid duplicates; codes are unique ignoring case. Confirmed deliveries preserve historical details.",
      annotations: WRITE,
      input: { workspace: workspaceParam, ...customerCreateSchema.shape },
    },
    async ({ workspace, ...json }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(api.client.v1.workspaces[":slug"].customers.$post({ param: { slug }, json }));
    },
  );
  define(
    "update_customer",
    {
      module: "customers",
      title: "Update customer",
      description:
        "Change only the provided customer fields. Archive rather than delete; changes do not rewrite confirmed delivery snapshots.",
      annotations: { ...WRITE, idempotentHint: true },
      input: { workspace: workspaceParam, customer_id: z.uuid(), changes: customerUpdateSchema },
    },
    async ({ workspace, customer_id: id, changes: json }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].customers[":id"].$patch({ param: { slug, id }, json }),
      );
    },
  );
  define(
    "list_despatches",
    {
      module: "despatch",
      resource: { name: "despatches", op: "list" },
      title: "List despatches",
      description:
        "Read customer-linked despatches by status, customer and date range. Drafts have not withdrawn stock; voided records remain in history. Paged.",
      annotations: READ,
      input: { workspace: workspaceParam, ...despatchListQuerySchema.shape },
    },
    async ({ workspace, ...q }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].despatch.$get({
          param: { slug },
          query: { ...q, limit: String(q.limit), offset: String(q.offset) },
        }),
      );
    },
  );
  define(
    "get_despatch",
    {
      module: "despatch",
      resource: { name: "despatches", op: "get" },
      title: "Get despatch",
      description:
        "Read a despatch's original recipient details, lot/location quantities and confirmation or correction evidence by UUID.",
      annotations: READ,
      input: { workspace: workspaceParam, despatch_id: z.uuid() },
    },
    async ({ workspace, despatch_id: id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(api.client.v1.workspaces[":slug"].despatch[":id"].$get({ param: { slug, id } }));
    },
  );
  define(
    "draft_despatch",
    {
      module: "despatch",
      title: "Draft despatch",
      description:
        "Create or replace a draft customer delivery. Customer, lot and location references are UUIDs. Quantities include units. No stock is withdrawn: a manager signed in to the app must confirm physical despatch. Confirmation and void are never available to API tokens.",
      annotations: WRITE,
      input: { workspace: workspaceParam, despatch_id: z.uuid().optional(), draft: despatchDraftSchema },
    },
    async ({ workspace, despatch_id: id, draft: json }, api) => {
      const slug = await slugOf(api, workspace);
      const routes = api.client.v1.workspaces[":slug"].despatch;
      return id
        ? api.call(routes[":id"].$put({ param: { slug, id }, json }))
        : api.call(routes.$post({ param: { slug }, json }));
    },
  );
  define(
    "get_lot_recipients",
    {
      module: "despatch",
      title: "Get lot recipients",
      description:
        "Read confirmed direct deliveries of one lot, with historical recipient contacts and quantities. Paged. This does not follow ingredient/WIP genealogy into other output lots and is not a complete recall impact report. Voided deliveries are excluded.",
      annotations: READ,
      input: { workspace: workspaceParam, lot_id: z.uuid(), ...despatchRecipientQuerySchema.shape },
    },
    async ({ workspace, lot_id: lotId, limit, offset }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].despatch.lots[":lotId"].recipients.$get({
          param: { slug, lotId },
          query: { limit: String(limit), offset: String(offset) },
        }),
      );
    },
  );
}
