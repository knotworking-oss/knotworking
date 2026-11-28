import type { TaskActivitySource, TaskBulkInput } from "@knotworking/core";
import { lockWorkspaceLog, tasks, teams, type Database } from "@knotworking/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { notFound } from "../errors";
import type { NotificationRow, NotifiedCallback } from "./notifications";
import { deleteTask, updateTask } from "./tasks";

export async function bulkChangeTasks(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: TaskBulkInput,
  onNotified: NotifiedCallback,
  source: TaskActivitySource,
) {
  const notices: NotificationRow[] = [];
  const ids = input.ids.map((id) => id.toLowerCase());
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const visible = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .innerJoin(teams, and(eq(teams.id, tasks.teamId), isNull(teams.deletedAt)))
      .where(and(eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt), inArray(tasks.id, ids)));
    if (visible.length !== ids.length) throw notFound("Task");
    for (const id of ids) {
      if (input.action === "delete") await deleteTask(tx, workspaceId, actorId, id, source);
      else
        await updateTask(tx, workspaceId, actorId, id, input.patch, (rows) => notices.push(...rows), source);
    }
  });
  if (notices.length) onNotified(notices);
  return { ids };
}
