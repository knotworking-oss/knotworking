import { rotaQuerySchema, staffingQuerySchema, workforceAvailabilitySchema } from "@knotworking/core";
import type { ToolContext } from "./shared";
import { READ } from "./shared";
export function registerWorkforceTools({ define, slugOf, workspaceParam }: ToolContext) {
  define(
    "get_workforce_availability",
    {
      module: "workforce",
      title: "Get workforce availability",
      description:
        "Paged unavailable date ranges for a window of at most 366 days. Shows names and dates only; no absence kind, sickness reason, notes or HR review history. Pending leave is excluded. No staffing/competence judgement is made.",
      annotations: READ,
      input: { workspace: workspaceParam, ...workforceAvailabilitySchema.shape },
    },
    async ({ workspace, ...input }, api) => {
      const slug = await slugOf(api, workspace);
      const query = workforceAvailabilitySchema.parse(input);
      return api.call(
        api.client.v1.workspaces[":slug"].workforce.availability.$get({
          param: { slug },
          query: { from: query.from, to: query.to, offset: String(query.offset) },
        }),
      );
    },
  );
  define(
    "get_rota",
    {
      module: "workforce",
      title: "Get the rota",
      description:
        "Shifts and rostered people for a window of at most 31 days, with each person's covered job role and agency. `unavailable` is true when the person is recorded as unavailable that day, and null when Private HR records are off (absences can't be seen). No absence kind, notes or HR history.",
      annotations: READ,
      input: { workspace: workspaceParam, from: rotaQuerySchema.shape.from, to: rotaQuerySchema.shape.to },
    },
    async ({ workspace, ...input }, api) => {
      const slug = await slugOf(api, workspace);
      const query = rotaQuerySchema.parse(input);
      return api.call(api.client.v1.workspaces[":slug"].workforce.rota.$get({ param: { slug }, query }));
    },
  );
  define(
    "get_staffing_check",
    {
      module: "workforce",
      title: "Check staffing against competence requirements",
      description:
        "For each date (window of at most 31 days) and shift: the staffing requirements that apply, who counts, the shortfall and why other rostered people don't count (role not held, training missing/expired/expiring before the shift/awaiting sign-off, recorded as unavailable). Training reasons are summarised unless the caller can read Training. Check `absenceSourceEnabled`, `trainingSourceEnabled` and `productionSourceEnabled` before treating a result as complete.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        from: staffingQuerySchema.shape.from,
        to: staffingQuerySchema.shape.to,
      },
    },
    async ({ workspace, ...input }, api) => {
      const slug = await slugOf(api, workspace);
      const query = staffingQuerySchema.parse(input);
      return api.call(api.client.v1.workspaces[":slug"].workforce.staffing.$get({ param: { slug }, query }));
    },
  );
}
