import {
  salesCommitmentsSchema,
  salesCreateSchema,
  salesListSchema,
  salesPageSchema,
  salesSaveSchema,
} from "@knotworking/core";
import { z } from "zod";
import { READ, type ToolContext } from "./shared";
export function registerSalesTools({ define, slugOf, workspaceParam }: ToolContext) {
  define(
    "list_sales_documents",
    {
      module: "sales",
      resource: { name: "sales_documents", op: "list" },
      title: "List sales orders and quotes",
      description:
        "Paged commercial documents owned by Knotworking. Drafts and quotes are not confirmed demand; daily sales commitments stay separate from weekly demand forecasts.",
      annotations: READ,
      input: { workspace: workspaceParam, ...salesListSchema.shape },
    },
    async ({ workspace, ...q }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].sales.orders.$get({
          param: { slug },
          query: { ...q, limit: String(q.limit), offset: String(q.offset) },
        }),
      );
    },
  );
  define(
    "get_sales_document",
    {
      module: "sales",
      resource: { name: "sales_documents", op: "get" },
      title: "Read sales document and retained revisions",
      description:
        "Read snapshotted customer/site, prices, stable line IDs and current revision. Optional revision history is paged. Signed-in managers alone may issue quotes, confirm, amend or cancel orders and link deliveries.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        document_id: z.uuid(),
        history: z.boolean().default(false),
        ...salesPageSchema.shape,
      },
    },
    async ({ workspace, document_id: id, history, limit, offset }, api) => {
      const slug = await slugOf(api, workspace);
      const routes = api.client.v1.workspaces[":slug"].sales.orders[":id"];
      return history
        ? api.call(
            routes.history.$get({
              param: { slug, id },
              query: { limit: String(limit), offset: String(offset) },
            }),
          )
        : api.call(routes.$get({ param: { slug, id } }));
    },
  );
  define(
    "draft_sales_document",
    {
      module: "sales",
      title: "Prepare a sales draft",
      description:
        "Create a quote/order draft or replace an existing draft using its reviewed revision and stable line IDs. Reuse commandId on identical retries. Omit new line IDs; omit unitPrice to use the customer agreement valid on dueOn. An explicit price is per entered unit. This cannot confirm, issue or amend a committed order, send messages, post stock, or copy orders into forecast demand.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      input: {
        workspace: workspaceParam,
        document_id: z.uuid().optional(),
        request: z.union([salesCreateSchema, salesSaveSchema]),
      },
    },
    async ({ workspace, document_id: id, request }, api) => {
      const slug = await slugOf(api, workspace);
      const routes = api.client.v1.workspaces[":slug"].sales.orders;
      if (id) {
        const json = salesSaveSchema.parse(request);
        return api.call(routes[":id"].$put({ param: { slug, id }, json }));
      }
      return api.call(routes.$post({ param: { slug }, json: salesCreateSchema.parse(request) }));
    },
  );
  define(
    "list_sales_prices",
    {
      module: "sales",
      resource: { name: "sales_prices", op: "list" },
      title: "Read customer price agreements",
      description:
        "Paged dated agreements, with currency, price unit, commercial terms and retained archived agreements. Agreeing or archiving prices requires a signed-in Sales manager.",
      annotations: READ,
      input: { workspace: workspaceParam, ...salesPageSchema.shape },
    },
    async ({ workspace, limit, offset }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].sales.prices.$get({
          param: { slug },
          query: { limit: String(limit), offset: String(offset) },
        }),
      );
    },
  );
  define(
    "get_sales_commitments",
    {
      module: "sales",
      title: "Read daily confirmed sales commitments",
      description:
        "Confirmed sales order lines by delivery date, with outstanding quantities in each item's base unit. Quotes and cancellations are excluded; confirmed linked despatches reduce outstanding. Returns do not automatically reopen orders. Forecasts are excluded and orders are not copied into production demand. Paged; dates span at most 367 days.",
      annotations: READ,
      input: { workspace: workspaceParam, query: salesCommitmentsSchema },
    },
    async ({ workspace, query: q }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"].sales.commitments.$get({
          param: { slug },
          query: { ...q, limit: String(q.limit), offset: String(q.offset) },
        }),
      );
    },
  );
}
