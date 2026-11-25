import { addDaysToIsoDate, projectTemplates, type ProjectFromTemplateInput } from "@knotworking/core";
import type { Database } from "@knotworking/db";
import { executeLedgerCommand } from "./ledger-command";
import type { NotificationRow, NotifiedCallback } from "./notifications";
import { createProject } from "./projects";
import { createTask } from "./tasks";

/** Creates an ordinary project and tasks together. Retries return the original project ID. */
export async function createProjectFromTemplate(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: ProjectFromTemplateInput,
  onNotified: NotifiedCallback,
) {
  const notified: NotificationRow[] = [];
  const result = await executeLedgerCommand(
    db,
    workspaceId,
    actorId,
    "projects.from_template",
    input,
    input,
    async (tx) => {
      const template = projectTemplates[input.templateId];
      const planned = template.tasks.map((task) => ({
        title: task.title,
        dueDate: addDaysToIsoDate(input.startDate, task.daysFromStart),
      }));
      const project = await createProject(tx, workspaceId, actorId, {
        name: input.name,
        leadId: input.leadId,
        teamIds: [input.teamId],
        startDate: planned[0]!.dueDate,
        targetDate: planned.at(-1)!.dueDate,
      });
      // The regular task service inserts at the top of the team's manual order.
      for (const task of [...planned].reverse()) {
        await createTask(
          tx,
          workspaceId,
          actorId,
          {
            ...task,
            projectId: project.id,
            teamId: input.teamId,
            assigneeId: input.leadId,
          },
          (created) => notified.push(...created),
        );
      }
      return { id: project.id };
    },
  );
  if (notified.length) onNotified(notified);
  return result;
}
