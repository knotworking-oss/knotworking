import { recurrenceScheduleSchema } from "@knotworking/core";
import { z } from "zod";
import type { Api } from "../api";
import { CREATE, READ, type ToolContext } from "./shared";

export function registerAutomationTools({ define, slugOf, workspaceParam }: ToolContext) {
  const automation = (api: Api) => api.client.v1.workspaces[":slug"].automation;
  const sourceTask = z.uuid().describe("UUID of the task that supplies the template.");

  define(
    "list_task_recurrences",
    {
      module: "automation",
      requiresModules: ["tasks"],
      resource: { name: "task_recurrences", op: "list" },
      title: "List recurring task schedules",
      description: "List scheduled tasks, their next dates and any scheduling errors.",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async ({ workspace }, api) => {
      const slug = await slugOf(api, workspace);
      const { recurrences } = await api.call(automation(api).$get({ param: { slug } }));
      return {
        recurrences: recurrences.map(({ id: recurrenceId, ...row }) => ({
          ...row,
          id: row.sourceTaskId,
          recurrenceId,
        })),
      };
    },
  );

  define(
    "get_task_recurrence",
    {
      module: "automation",
      requiresModules: ["tasks"],
      resource: { name: "task_recurrences", op: "get" },
      title: "Read a task's repeat schedule",
      description: "Read the repeat schedule and its next date by source task UUID.",
      annotations: READ,
      input: { workspace: workspaceParam, task_id: sourceTask },
    },
    async ({ workspace, task_id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(automation(api).recurrences[":taskId"].$get({ param: { slug, taskId: task_id } }));
    },
  );

  define(
    "set_task_recurrence",
    {
      module: "automation",
      requiresModules: ["tasks"],
      title: "Set a task's repeat schedule",
      description:
        "Create, update or pause a repeat schedule. Use the workspace date for firstOn, ISO weekdays (Monday is 1) and the full existing schedule when pausing it.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        task_id: sourceTask,
        schedule: recurrenceScheduleSchema,
        enabled: z.boolean(),
      },
    },
    async ({ workspace, task_id, schedule, enabled }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(
        automation(api).recurrences[":taskId"].$put({
          param: { slug, taskId: task_id },
          json: { schedule, enabled },
        }),
      );
    },
  );
}
