import { serviceQuoteListSchema } from "@knotworking/core";
import { z } from "zod";
import { READ, type ToolContext } from "./shared";

export function registerClientServiceTools({ define, slugOf, workspaceParam }: ToolContext) {
  define(
    "list_service_quotes",
    {
      module: "client_services",
      resource: { name: "service_quotes", op: "list" },
      title: "List service quotes",
      description:
        "Read fixed-fee and hourly service quotes, their status, delivery project and any signed-off billing total. Use nextCursor as before for the next page.",
      annotations: READ,
      input: { workspace: workspaceParam, ...serviceQuoteListSchema.shape },
    },
    async ({ workspace, ...query }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(api.client.v1.workspaces[":slug"]["client-services"].$get({ param: { slug }, query }));
    },
  );
  define(
    "get_service_quote",
    {
      module: "client_services",
      resource: { name: "service_quotes", op: "get" },
      title: "Read a service quote",
      description:
        "Read the scope, customer snapshot, price, linked delivery project, approved billing and recent decisions.",
      annotations: READ,
      input: { workspace: workspaceParam, quote_id: z.uuid() },
    },
    async ({ workspace, quote_id: id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        api.client.v1.workspaces[":slug"]["client-services"][":id"].$get({ param: { slug, id } }),
      );
    },
  );
}
