import {
  addDaysToIsoDate,
  planProjectTemplate,
  type DocContent,
  type DocNode,
  type ModuleId,
  type PlannedTemplateTask,
  type ProjectFromTemplateInput,
} from "@knotworking/core";
import type { Database } from "@knotworking/db";
import { ApiError, badRequest } from "../errors";
import { executeLedgerCommand } from "./ledger-command";
import type { NotificationRow, NotifiedCallback } from "./notifications";
import { createProject } from "./projects";
import { createTask } from "./tasks";

export interface TemplateCreator {
  /** The workspace slug, for links to module pages in task descriptions. */
  slug: string;
  /** Whether the creator can use a module: active in the workspace and readable by them. */
  canUse: (moduleId: ModuleId) => boolean;
}

interface Planned {
  title: string;
  daysFromStart: number;
  step: PlannedTemplateTask | null;
}

/**
 * The tasks to create: the template's plan for the creator, or the edited list they sent. A sent
 * task naming a step takes that step's guidance and link; a step from a module the creator can't
 * use is refused, and unknown steps are a bad request.
 */
function resolveTasks(input: ProjectFromTemplateInput, creator: TemplateCreator): Planned[] {
  const plan = planProjectTemplate(input.templateId, creator.canUse);
  if (!input.tasks)
    return plan.map((step) => ({ title: step.title, daysFromStart: step.daysFromStart, step }));
  const everyStep = planProjectTemplate(input.templateId, () => true);
  return input.tasks.map((task) => {
    if (!task.step) return { title: task.title, daysFromStart: task.daysFromStart, step: null };
    const step = plan.find((s) => s.key === task.step);
    if (step) return { title: task.title, daysFromStart: task.daysFromStart, step };
    const other = everyStep.find((s) => s.key === task.step);
    if (other?.module)
      throw new ApiError(
        403,
        "module_forbidden",
        `The "${other.title}" step needs the ${other.module} module, which you can't use in this workspace`,
      );
    throw badRequest(`Unknown step "${task.step}" for this template`);
  });
}

function stepDescription(step: PlannedTemplateTask | null, slug: string): DocContent | undefined {
  if (!step || (!step.detail && !step.link)) return undefined;
  const content: DocNode[] = [];
  if (step.detail) content.push({ type: "paragraph", content: [{ type: "text", text: step.detail }] });
  if (step.link)
    content.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: step.link.label,
          marks: [{ type: "link", attrs: { href: `/${slug}/${step.link.path}` } }],
        },
      ],
    });
  return { type: "doc", content };
}

/**
 * Creates an ordinary project and dated tasks together. Retries return the original project ID.
 *
 * The command receipt is checked first (the route has already required Tasks `write`): an
 * identical retry returns the original project even if a module grant has changed since, and a
 * reused command ID with other input is a 409. Steps are resolved and authorized only for a new
 * command, inside its transaction.
 */
export async function createProjectFromTemplate(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: ProjectFromTemplateInput,
  creator: TemplateCreator,
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
      const resolved = resolveTasks(input, creator);
      const planned = resolved
        .map((task, order) => ({
          title: task.title,
          dueDate: addDaysToIsoDate(input.startDate, task.daysFromStart),
          description: stepDescription(task.step, creator.slug),
          order,
        }))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.order - b.order);
      const project = await createProject(tx, workspaceId, actorId, {
        name: input.name,
        leadId: input.leadId,
        teamIds: [input.teamId],
        startDate: planned[0]!.dueDate,
        targetDate: planned.at(-1)!.dueDate,
      });
      // The regular task service inserts at the top of the team's manual order.
      for (const { order: _order, description, ...task } of [...planned].reverse()) {
        await createTask(
          tx,
          workspaceId,
          actorId,
          {
            ...task,
            ...(description ? { description } : {}),
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
