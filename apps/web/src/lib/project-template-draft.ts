import {
  addDaysToIsoDate,
  daysBetween,
  planProjectTemplate,
  projectTemplateDateIssue,
  projectTemplateModules,
  type ModuleAccessLevel,
  type ModuleId,
  type ProjectTemplateId,
  type ProjectTemplateTaskInput,
} from "@knotworking/core";

/** One row of the editable task list in the template dialog. */
export interface DraftTemplateTask {
  /** Local row id (React key). */
  id: string;
  /** The template step it came from; custom rows have none. */
  step?: string;
  title: string;
  daysFromStart: number;
  /** The module whose step it is (null: a starter or custom task). */
  module: ModuleId | null;
}

/** The template's plan for this viewer, as editable rows. */
export function draftTemplateTasks(
  templateId: ProjectTemplateId,
  canUse: (moduleId: ModuleId) => boolean,
): DraftTemplateTask[] {
  return planProjectTemplate(templateId, canUse).map((task) => ({
    id: task.key,
    step: task.key,
    title: task.title,
    daysFromStart: task.daysFromStart,
    module: task.module,
  }));
}

/** A row's due date for the chosen milestone date. */
export const draftTaskDate = (milestoneDate: string, task: Pick<DraftTemplateTask, "daysFromStart">) =>
  addDaysToIsoDate(milestoneDate, task.daysFromStart);

/** The offset for a due date picked in a row (relative to the milestone date). */
export const draftTaskOffset = (milestoneDate: string, dueDate: string) =>
  daysBetween(milestoneDate, dueDate);

/** First and last due date of the rows (the project's start and target dates). */
export function draftTemplateSpan(milestoneDate: string, tasks: readonly DraftTemplateTask[]) {
  if (!tasks.length || draftDateIssue(milestoneDate, tasks)) return null;
  const offsets = tasks.map((t) => t.daysFromStart);
  return {
    start: addDaysToIsoDate(milestoneDate, Math.min(...offsets)),
    target: addDaysToIsoDate(milestoneDate, Math.max(...offsets)),
  };
}

/**
 * Why the rows can't be created for this milestone date (a due date outside 0001–9999), or null.
 * The same check the API makes.
 */
export const draftDateIssue = (milestoneDate: string, tasks: readonly DraftTemplateTask[]) =>
  projectTemplateDateIssue(
    milestoneDate,
    tasks.map((t) => t.daysFromStart),
  );

/** The rows as the API takes them. */
export const draftTasksInput = (tasks: readonly DraftTemplateTask[]): ProjectTemplateTaskInput[] =>
  tasks.map((task) => ({
    ...(task.step ? { step: task.step } : {}),
    title: task.title.trim(),
    daysFromStart: task.daysFromStart,
  }));

export type SuggestedModuleState = "available" | "no_access" | "inactive";

/** Each module that adds steps to the template, and whether it will for this viewer. */
export function suggestedTemplateModules(
  templateId: ProjectTemplateId,
  modules: readonly { id: ModuleId; access: ModuleAccessLevel }[],
): { id: ModuleId; state: SuggestedModuleState }[] {
  return projectTemplateModules(templateId).map((id) => {
    const summary = modules.find((m) => m.id === id);
    const state: SuggestedModuleState = !summary
      ? "inactive"
      : summary.access === "none"
        ? "no_access"
        : "available";
    return { id, state };
  });
}
