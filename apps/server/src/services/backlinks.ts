import type { BacklinksResponse, MentionKind } from "@knotworking/core";
import { documents, tasks, teams, type Database } from "@knotworking/db";
import { and, desc, eq, isNull, ne, sql, type SQLWrapper } from "drizzle-orm";
import { notFound } from "../errors";
import { SEARCH_CANDIDATE_LIMIT } from "./search";

/**
 * "Linked from" / "Mentioned in": the documents and tasks whose body mentions a given document or task.
 *
 * There is no link table. Mentions live in the JSONB bodies (`{ type: "mention", attrs: { kind, id } }`
 * nodes), so the query finds them with a `jsonb_path_exists` over the workspace's most recently updated
 * live rows (the same bounded candidate window as search, `SEARCH_CANDIDATE_LIMIT`), newest first, at
 * most `BACKLINK_LIMIT` per kind. The kind and id travel as a bound jsonpath variable, never in the
 * path text. Deleted rows, rows of archived teams and other workspaces never match, and a row doesn't
 * link to itself.
 */
export const BACKLINK_LIMIT = 50;

const mentions = (column: SQLWrapper, kind: MentionKind, id: string) =>
  sql`jsonb_path_exists(${column},
    'strict $.** ? (@.type == "mention" && @.attrs.kind == $kind && @.attrs.id == $id)',
    ${JSON.stringify({ kind, id })}::jsonb, true)`;

export async function listBacklinks(
  db: Database,
  workspaceId: string,
  target: { kind: Exclude<MentionKind, "user">; id: string },
  /** Kinds the caller may see (module access); a hidden kind returns no links. */
  visible: { documents: boolean; tasks: boolean } = { documents: true, tasks: true },
): Promise<BacklinksResponse> {
  // The target must be a live row of this workspace, so ids of other workspaces or deleted rows are a 404.
  const [exists] =
    target.kind === "doc"
      ? await db
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.id, target.id),
              eq(documents.workspaceId, workspaceId),
              isNull(documents.deletedAt),
            ),
          )
      : await db
          .select({ id: tasks.id })
          .from(tasks)
          .innerJoin(teams, and(eq(teams.id, tasks.teamId), isNull(teams.deletedAt)))
          .where(and(eq(tasks.id, target.id), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)));
  if (!exists) throw notFound(target.kind === "doc" ? "Document" : "Task");

  const docCandidates = db
    .select({
      id: documents.id,
      title: documents.title,
      icon: documents.icon,
      updatedAt: documents.updatedAt,
      content: documents.content,
    })
    .from(documents)
    .where(
      and(
        eq(documents.workspaceId, workspaceId),
        isNull(documents.deletedAt),
        target.kind === "doc" ? ne(documents.id, target.id) : undefined,
      ),
    )
    .orderBy(desc(documents.updatedAt))
    .limit(SEARCH_CANDIDATE_LIMIT)
    .as("cand");
  const taskCandidates = db
    .select({
      id: tasks.id,
      title: tasks.title,
      teamId: tasks.teamId,
      stateId: tasks.stateId,
      updatedAt: tasks.updatedAt,
      description: tasks.description,
    })
    .from(tasks)
    // Tasks of archived teams are hidden along with the team (as in the task list).
    .innerJoin(teams, and(eq(teams.id, tasks.teamId), isNull(teams.deletedAt)))
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        isNull(tasks.deletedAt),
        target.kind === "task" ? ne(tasks.id, target.id) : undefined,
      ),
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(SEARCH_CANDIDATE_LIMIT)
    .as("cand");

  const [docs, found] = await Promise.all([
    !visible.documents
      ? []
      : db
          .select({
            id: docCandidates.id,
            title: docCandidates.title,
            icon: docCandidates.icon,
            updatedAt: docCandidates.updatedAt,
          })
          .from(docCandidates)
          .where(mentions(docCandidates.content, target.kind, target.id))
          .orderBy(desc(docCandidates.updatedAt), docCandidates.id)
          .limit(BACKLINK_LIMIT),
    !visible.tasks
      ? []
      : db
          .select({
            id: taskCandidates.id,
            title: taskCandidates.title,
            teamId: taskCandidates.teamId,
            stateId: taskCandidates.stateId,
            updatedAt: taskCandidates.updatedAt,
          })
          .from(taskCandidates)
          .where(mentions(taskCandidates.description, target.kind, target.id))
          .orderBy(desc(taskCandidates.updatedAt), taskCandidates.id)
          .limit(BACKLINK_LIMIT),
  ]);
  return {
    documents: docs.map((d) => ({ ...d, updatedAt: d.updatedAt.toISOString() })),
    tasks: found.map((t) => ({ ...t, updatedAt: t.updatedAt.toISOString() })),
  };
}
