import { documents, tasks, projects, teams, workspaceMembers, type Executor } from "@knotworking/db";
import { and, eq, isNull } from "drizzle-orm";
import { badRequest } from "../errors";

/**
 * Validates IDs a client sends that point at other records: each must exist,
 * be live, and belong to the same workspace (assignees must be active members).
 */
export async function assertRefs(
  db: Executor,
  workspaceId: string,
  refs: {
    assigneeId?: string | null;
    projectId?: string | null;
    teamId?: string | null;
    taskParentId?: string | null;
    documentParentId?: string | null;
  },
) {
  const check = async (ok: Promise<unknown[]>, field: string) => {
    if ((await ok).length === 0) throw badRequest(`Unknown ${field}`);
  };
  const checks: Promise<void>[] = [];
  if (refs.assigneeId) {
    checks.push(
      check(
        db
          .select({ id: workspaceMembers.id })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, workspaceId),
              eq(workspaceMembers.userId, refs.assigneeId),
              isNull(workspaceMembers.deletedAt),
            ),
          ),
        "assigneeId",
      ),
    );
  }
  if (refs.projectId) {
    checks.push(
      check(
        db
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.id, refs.projectId),
              eq(projects.workspaceId, workspaceId),
              isNull(projects.deletedAt),
            ),
          ),
        "projectId",
      ),
    );
  }
  if (refs.teamId) {
    checks.push(
      check(
        db
          .select({ id: teams.id })
          .from(teams)
          .where(and(eq(teams.id, refs.teamId), eq(teams.workspaceId, workspaceId), isNull(teams.deletedAt))),
        "teamId",
      ),
    );
  }
  if (refs.taskParentId) {
    checks.push(
      check(
        db
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(eq(tasks.id, refs.taskParentId), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)),
          ),
        "parentId",
      ),
    );
  }
  if (refs.documentParentId) {
    checks.push(
      check(
        db
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.id, refs.documentParentId),
              eq(documents.workspaceId, workspaceId),
              isNull(documents.deletedAt),
            ),
          ),
        "parentId",
      ),
    );
  }
  await Promise.all(checks);
}

/**
 * Rejects a parent change that would make `id` its own ancestor (A → B → A),
 * which would detach both from the tree. Walks up from the proposed parent.
 */
export async function assertNoCycle(
  db: Executor,
  table: typeof tasks | typeof documents,
  id: string,
  newParentId: string | null | undefined,
) {
  let current = newParentId ?? null;
  for (let depth = 0; current; depth++) {
    if (current === id) throw badRequest("That would make it its own parent");
    if (depth > 64) throw badRequest("Nesting is too deep");
    const [row] = await db.select({ parentId: table.parentId }).from(table).where(eq(table.id, current));
    current = row?.parentId ?? null;
  }
}
