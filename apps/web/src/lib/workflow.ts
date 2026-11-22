import type { WorkflowStateType } from "@knotworking/core";

/** How each workflow state category is described when editing a team's workflow. */
export const stateTypeInfo: Record<WorkflowStateType, { label: string; help: string }> = {
  backlog: { label: "Backlog", help: "Ideas and work that isn't planned yet" },
  unstarted: { label: "Todo", help: "Planned and ready to start" },
  started: { label: "In progress", help: "Being worked on; counts towards progress" },
  completed: { label: "Done", help: "Finished; sets the completion date" },
  canceled: { label: "Canceled", help: "Won't be done; left out of progress" },
};

/** True for roles that can change teams, workflows and labels. */
export const canManageStructure = (role: string | undefined) => role === "owner" || role === "admin";
