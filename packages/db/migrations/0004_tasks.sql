-- Issues become tasks. Everything is renamed in place, so existing data is kept.
ALTER TABLE "issues" RENAME TO "tasks";--> statement-breakpoint
ALTER TABLE "issue_labels" RENAME TO "task_labels";--> statement-breakpoint
ALTER TABLE "task_labels" RENAME COLUMN "issue_id" TO "task_id";--> statement-breakpoint
ALTER TABLE "comments" RENAME COLUMN "issue_id" TO "task_id";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_pkey" TO "tasks_pkey";--> statement-breakpoint
ALTER TABLE "task_labels" RENAME CONSTRAINT "issue_labels_pkey" TO "task_labels_pkey";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_workspace_id_workspaces_id_fk" TO "tasks_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_team_id_teams_id_fk" TO "tasks_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_state_id_workflow_states_id_fk" TO "tasks_state_id_workflow_states_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_assignee_id_users_id_fk" TO "tasks_assignee_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_creator_id_users_id_fk" TO "tasks_creator_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_project_id_projects_id_fk" TO "tasks_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_parent_id_issues_id_fk" TO "tasks_parent_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "task_labels" RENAME CONSTRAINT "issue_labels_workspace_id_workspaces_id_fk" TO "task_labels_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "task_labels" RENAME CONSTRAINT "issue_labels_issue_id_issues_id_fk" TO "task_labels_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "task_labels" RENAME CONSTRAINT "issue_labels_label_id_labels_id_fk" TO "task_labels_label_id_labels_id_fk";--> statement-breakpoint
ALTER TABLE "comments" RENAME CONSTRAINT "comments_issue_id_issues_id_fk" TO "comments_task_id_tasks_id_fk";--> statement-breakpoint
ALTER INDEX "issues_workspace_updated_idx" RENAME TO "tasks_workspace_updated_idx";--> statement-breakpoint
ALTER INDEX "issues_team_state_idx" RENAME TO "tasks_team_state_idx";--> statement-breakpoint
ALTER INDEX "issues_assignee_idx" RENAME TO "tasks_assignee_idx";--> statement-breakpoint
ALTER INDEX "issues_project_idx" RENAME TO "tasks_project_idx";--> statement-breakpoint
ALTER INDEX "issues_parent_idx" RENAME TO "tasks_parent_idx";--> statement-breakpoint
ALTER INDEX "issue_labels_issue_label_key" RENAME TO "task_labels_task_label_key";--> statement-breakpoint
ALTER INDEX "comments_issue_idx" RENAME TO "comments_task_idx";--> statement-breakpoint
-- No more team-scoped numbers (ENG-42): tasks are addressed by ID.
ALTER TABLE "tasks" DROP COLUMN "number";--> statement-breakpoint
ALTER TABLE "teams" DROP COLUMN "issue_counter";--> statement-breakpoint
-- Keep the sync log consistent with the new entity names and shapes.
UPDATE "sync_changes" SET "entity" = 'task', "data" = "data" - 'number' WHERE "entity" = 'issue';--> statement-breakpoint
UPDATE "sync_changes"
SET "entity" = 'task_label',
  "data" = CASE WHEN "data" ? 'issueId' THEN ("data" - 'issueId') || jsonb_build_object('taskId', "data" -> 'issueId') ELSE "data" END
WHERE "entity" = 'issue_label';--> statement-breakpoint
UPDATE "sync_changes" SET "data" = "data" - 'issueCounter' WHERE "entity" = 'team' AND "data" ? 'issueCounter';
--> statement-breakpoint
UPDATE "sync_changes"
SET "data" = ("data" - 'issueId') || jsonb_build_object('taskId', "data" -> 'issueId')
WHERE "entity" = 'comment' AND "data" ? 'issueId';
