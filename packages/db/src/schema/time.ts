/**
 * Time tracking module (`time`): time logged against tasks and each member's running timer.
 * See docs/modules.md.
 */
import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { tasks } from "./tasks";

/**
 * Time logged against a task. A row is either a finished entry (`minutes` set) or a
 * user's running timer (`minutes` null, `started_at` set). Each user has at most one
 * running timer per workspace (partial unique index). Workspace data: written to the
 * sync log like tasks.
 */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** Whose time it is. Null once that account is gone (the time still counts). */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Whole minutes, 1–1440. Null only while the timer runs. */
    minutes: integer("minutes"),
    note: text("note"),
    /** The day the work happened, in the user's calendar. */
    entryDate: date("entry_date").notNull(),
    /** When the timer was started (kept after it stops); null for manual entries. */
    startedAt: ts("started_at"),
    ...timestamps(),
  },
  (t) => [
    index("time_entries_task_idx").on(t.taskId),
    index("time_entries_workspace_user_date_idx").on(t.workspaceId, t.userId, t.entryDate),
    uniqueIndex("time_entries_running_key")
      .on(t.workspaceId, t.userId)
      .where(sql`${t.minutes} is null and ${t.deletedAt} is null`),
    check(
      "time_entries_minutes_check",
      sql`${t.minutes} is null or (${t.minutes} > 0 and ${t.minutes} <= 1440)`,
    ),
  ],
);
