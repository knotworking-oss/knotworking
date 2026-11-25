import type { Bootstrap, DocumentMeta, TaskSummary, WorkflowState } from "@/lib/api";

const stamp = "2026-01-01T00:00:00.000Z";

/** A task with sensible defaults; override only what the test is about. */
export function makeTask(overrides: Partial<TaskSummary> & { id: string }): TaskSummary {
  return {
    teamId: "team-1",
    title: `Task ${overrides.id}`,
    stateId: "todo",
    priority: 0,
    estimateMinutes: null,
    assigneeId: null,
    creatorId: null,
    projectId: null,
    parentId: null,
    startDate: null,
    dueDate: null,
    sortOrder: "a0",
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    createdAt: stamp,
    updatedAt: stamp,
    labelIds: [],
    ...overrides,
  } as TaskSummary;
}

/** A doc (metadata only, as the bootstrap carries it); override only what the test is about. */
export function makeDoc(overrides: Partial<DocumentMeta> & { id: string }): DocumentMeta {
  return {
    parentId: null,
    teamId: null,
    projectId: null,
    title: `Doc ${overrides.id}`,
    icon: null,
    coverUrl: null,
    sortOrder: "a0",
    creatorId: null,
    lastEditedById: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  } as DocumentMeta;
}

export function makeState(
  overrides: Partial<WorkflowState> & { id: string; type: WorkflowState["type"] },
): WorkflowState {
  return {
    workspaceId: "ws",
    teamId: "team-1",
    name: overrides.id,
    description: null,
    sortOrder: "a0",
    createdAt: stamp,
    updatedAt: stamp,
    deletedAt: null,
    ...overrides,
  } as WorkflowState;
}

/** A minimal bootstrap snapshot: one team with the usual workflow, plus the given tasks. */
export function makeBootstrap(tasks: TaskSummary[] = [], overrides: Partial<Bootstrap> = {}): Bootstrap {
  return {
    cursor: "0",
    modules: (["tasks", "docs", "time", "calendar"] as const).map((id) => ({
      id,
      name: id,
      description: "",
      dependsOn: [],
      enhancedBy: [],
      access: "write" as const,
    })),
    workspace: { id: "ws", slug: "acme", name: "Acme" },
    users: [{ id: "u1", name: "Ada", email: "ada@example.com", avatarUrl: null, role: "owner" }],
    teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
    teamMembers: [],
    workflowStates: [
      makeState({ id: "backlog", type: "backlog", sortOrder: "a0" }),
      makeState({ id: "todo", type: "unstarted", sortOrder: "a1" }),
      makeState({ id: "doing", type: "started", sortOrder: "a2" }),
      makeState({ id: "review", type: "started", sortOrder: "a3" }),
      makeState({ id: "done", type: "completed", sortOrder: "a4" }),
      makeState({ id: "canceled", type: "canceled", sortOrder: "a5" }),
    ],
    labels: [],
    projects: [],
    projectTeams: [],
    tasks,
    taskRelations: [],
    documents: [],
    meetings: [],
    meetingAttendees: [],
    timeEntries: [],
    ...overrides,
  } as unknown as Bootstrap;
}
