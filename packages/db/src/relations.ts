import { relations } from "drizzle-orm";
import {
  apiTokens,
  comments,
  documents,
  taskLabels,
  taskRelations,
  tasks,
  labels,
  projects,
  projectTeams,
  teamMembers,
  teams,
  users,
  workflowStates,
  workspaceMembers,
  workspaces,
} from "./schema";

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  members: many(workspaceMembers),
  teams: many(teams),
  projects: many(projects),
  documents: many(documents),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(workspaceMembers),
  apiTokens: many(apiTokens),
}));

export const apiTokensRelations = relations(apiTokens, ({ one }) => ({
  user: one(users, { fields: [apiTokens.userId], references: [users.id] }),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, { fields: [workspaceMembers.workspaceId], references: [workspaces.id] }),
  user: one(users, { fields: [workspaceMembers.userId], references: [users.id] }),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [teams.workspaceId], references: [workspaces.id] }),
  members: many(teamMembers),
  states: many(workflowStates),
  tasks: many(tasks),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, { fields: [teamMembers.teamId], references: [teams.id] }),
  user: one(users, { fields: [teamMembers.userId], references: [users.id] }),
}));

export const workflowStatesRelations = relations(workflowStates, ({ one }) => ({
  team: one(teams, { fields: [workflowStates.teamId], references: [teams.id] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  lead: one(users, { fields: [projects.leadId], references: [users.id] }),
  teams: many(projectTeams),
  tasks: many(tasks),
}));

export const projectTeamsRelations = relations(projectTeams, ({ one }) => ({
  project: one(projects, { fields: [projectTeams.projectId], references: [projects.id] }),
  team: one(teams, { fields: [projectTeams.teamId], references: [teams.id] }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  team: one(teams, { fields: [tasks.teamId], references: [teams.id] }),
  state: one(workflowStates, { fields: [tasks.stateId], references: [workflowStates.id] }),
  assignee: one(users, { fields: [tasks.assigneeId], references: [users.id], relationName: "assignee" }),
  creator: one(users, { fields: [tasks.creatorId], references: [users.id], relationName: "creator" }),
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  parent: one(tasks, { fields: [tasks.parentId], references: [tasks.id], relationName: "subtasks" }),
  children: many(tasks, { relationName: "subtasks" }),
  labels: many(taskLabels),
  comments: many(comments),
  blocks: many(taskRelations, { relationName: "blocking" }),
  blockedBy: many(taskRelations, { relationName: "blocked" }),
}));

export const taskRelationsRelations = relations(taskRelations, ({ one }) => ({
  blockingTask: one(tasks, {
    fields: [taskRelations.blockingTaskId],
    references: [tasks.id],
    relationName: "blocking",
  }),
  blockedTask: one(tasks, {
    fields: [taskRelations.blockedTaskId],
    references: [tasks.id],
    relationName: "blocked",
  }),
}));

export const taskLabelsRelations = relations(taskLabels, ({ one }) => ({
  task: one(tasks, { fields: [taskLabels.taskId], references: [tasks.id] }),
  label: one(labels, { fields: [taskLabels.labelId], references: [labels.id] }),
}));

export const labelsRelations = relations(labels, ({ many }) => ({
  tasks: many(taskLabels),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  parent: one(documents, { fields: [documents.parentId], references: [documents.id], relationName: "tree" }),
  children: many(documents, { relationName: "tree" }),
  creator: one(users, { fields: [documents.creatorId], references: [users.id] }),
  comments: many(comments),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  task: one(tasks, { fields: [comments.taskId], references: [tasks.id] }),
  document: one(documents, { fields: [comments.documentId], references: [documents.id] }),
  author: one(users, { fields: [comments.authorId], references: [users.id] }),
}));
