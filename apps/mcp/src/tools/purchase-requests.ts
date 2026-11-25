import { purchaseRequestListSchema } from "@knotworking/core";
import { z } from "zod";
import { READ, type ToolContext } from "./shared";

export function registerPurchaseRequestTools({ define, slugOf, workspaceParam }: ToolContext) {
  define(
    "list_purchase_requests",
    {
      module: "purchase_requests",
      resource: { name: "purchase_requests", op: "list" },
      title: "List purchase requests",
      description:
        "Read your submissions or the requests assigned to you. Managers may list all requests. Use nextCursor as before for the next page.",
      annotations: READ,
      input: { workspace: workspaceParam, ...purchaseRequestListSchema.shape },
    },
    async ({ workspace, ...query }, api) => {
      const slug = await slugOf(api, workspace);
      const { requests, nextCursor } = await api.call(
        api.client.v1.workspaces[":slug"]["purchase-requests"].$get({ param: { slug }, query }),
      );
      return { requests, nextCursor };
    },
  );
  define(
    "get_purchase_request",
    {
      module: "purchase_requests",
      resource: { name: "purchase_requests", op: "get" },
      title: "Read a purchase request",
      description:
        "Read the request's reason, estimated cost, approver, current status and recorded decision.",
      annotations: READ,
      input: { workspace: workspaceParam, request_id: z.uuid() },
    },
    async ({ workspace, request_id: id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"]["purchase-requests"][":id"].$get({ param: { slug, id } }),
      );
    },
  );
}
