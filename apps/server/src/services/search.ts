import {
  docToPlainText,
  findMatches,
  makeSnippet,
  searchTerms,
  type DocumentSearchHit,
  type SearchQuery,
  type SearchResponse,
  type TaskSearchHit,
} from "@knotworking/core";
import { documents, tasks, teams, type Database } from "@knotworking/db";
import { and, desc, eq, isNull, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * Workspace search over documents and tasks (title and body), with no stored index.
 *
 * Bodies are JSONB block trees (`DocContent`). Each query takes the workspace's most recently
 * updated live rows (at most `CANDIDATE_LIMIT`: far more than a small team has), derives their
 * plain text in SQL and matches with:
 *
 * - Postgres full-text search: the `simple` configuration (no stemming or stop words, so it is
 *   language-neutral and identical on PGlite, Neon and Supabase), every query word as a prefix
 *   (`plan:*`), all words required, in any order, title weighted above body; and
 * - a case-insensitive substring match of the whole query, which covers what the text-search
 *   parser tokenises differently: `C++`, `foo.bar()`, email addresses, `$100`.
 *
 * Only the top `limit` rows are returned, ranked by text-search rank plus bonuses for a title that
 * contains (or starts with) the query, newest first on ties. User input only ever reaches SQL as
 * bound parameters; the tsquery is built from letter/digit runs, so it can't carry operators.
 *
 * If a workspace outgrows this, store the extracted text as a generated `tsvector` column with a
 * GIN index (maintained in the same transaction as the write) and keep this query shape.
 */
export const SEARCH_CANDIDATE_LIMIT = 2000;

/**
 * Plain text of a `DocContent` column, one line per text block (paragraph, heading, code block),
 * mirroring `docToPlainText`: text of the block's text nodes concatenated (marks split text nodes
 * mid-word), blocks joined by newlines. `lax`-mode path duplicates are avoided with `strict` and
 * the silent flag, and only `text` of `type: "text"` nodes counts (not node attributes).
 */
const textOf = (column: SQLWrapper) => sql<string>`coalesce((
  select string_agg(b.txt, chr(10) order by blk.ord)
  from jsonb_path_query(${column},
    'strict $.** ? (@.type == "paragraph" || @.type == "heading" || @.type == "codeBlock")',
    '{}', true) with ordinality as blk(node, ord)
  cross join lateral (
    select coalesce(string_agg(t #>> '{}', '' order by o), '') as txt
    from jsonb_path_query(blk.node,
      'strict $.** ? (@.type == "text" && @.text.type() == "string").text',
      '{}', true) with ordinality as tt(t, o)
  ) b
), '')`;

const vectorOf = (title: SQLWrapper, body: SQLWrapper) =>
  sql`(setweight(to_tsvector('simple', ${title}), 'A') || setweight(to_tsvector('simple', ${body}), 'B'))`;

/** Escapes `!` (the ESCAPE character), `%` and `_` so the query is matched literally. */
const likePattern = (q: string, { prefix = false } = {}) =>
  `${prefix ? "" : "%"}${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;

interface Matcher {
  /** `where` and `order by` pieces over a candidate subquery's `title`, `body` and `vec` columns. */
  where: (c: { title: SQLWrapper; body: SQLWrapper; vec: SQLWrapper }) => SQL;
  score: (c: { title: SQLWrapper; vec: SQLWrapper }) => SQL<number>;
}

function matcher(q: string): Matcher {
  const phrase = q.trim().replace(/\s+/g, " ");
  const terms = searchTerms(phrase);
  const tsquery = terms.length
    ? sql`to_tsquery('simple', ${terms.map((t) => `'${t}':*`).join(" & ")})`
    : null;
  const contains = likePattern(phrase);
  const startsWith = likePattern(phrase, { prefix: true });
  return {
    where: ({ title, body, vec }) =>
      or(
        tsquery ? sql`${vec} @@ ${tsquery}` : undefined,
        sql`${title} ilike ${contains} escape '!'`,
        sql`${body} ilike ${contains} escape '!'`,
      )!,
    score: ({ title, vec }) =>
      sql<number>`(${tsquery ? sql`ts_rank(${vec}, ${tsquery})` : sql`0`}
        + case when ${title} ilike ${contains} escape '!' then 1 else 0 end
        + case when ${title} ilike ${startsWith} escape '!' then 0.5 else 0 end)`,
  };
}

function presentation(q: string) {
  const phrase = q.trim().replace(/\s+/g, " ");
  const terms = searchTerms(phrase);
  return (title: string, bodyContent: unknown) => {
    const { snippet, matches } = makeSnippet(
      docToPlainText(bodyContent as Parameters<typeof docToPlainText>[0]),
      phrase,
      terms,
    );
    return { titleMatches: findMatches(title, phrase, terms), snippet, snippetMatches: matches };
  };
}

export async function searchDocuments(
  db: Database,
  workspaceId: string,
  q: string,
  limit: number,
): Promise<DocumentSearchHit[]> {
  const m = matcher(q);
  const present = presentation(q);
  const cand = db
    .select({
      id: documents.id,
      title: documents.title,
      icon: documents.icon,
      parentId: documents.parentId,
      teamId: documents.teamId,
      projectId: documents.projectId,
      updatedAt: documents.updatedAt,
      content: documents.content,
      body: textOf(documents.content).as("body"),
    })
    .from(documents)
    .where(and(eq(documents.workspaceId, workspaceId), isNull(documents.deletedAt)))
    .orderBy(desc(documents.updatedAt))
    .limit(SEARCH_CANDIDATE_LIMIT)
    .as("cand");
  const vec = vectorOf(cand.title, cand.body);
  const rows = await db
    .select()
    .from(cand)
    .where(m.where({ title: cand.title, body: cand.body, vec }))
    .orderBy(desc(m.score({ title: cand.title, vec })), desc(cand.updatedAt), cand.id)
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    icon: r.icon,
    parentId: r.parentId,
    teamId: r.teamId,
    projectId: r.projectId,
    updatedAt: r.updatedAt.toISOString(),
    ...present(r.title, r.content),
  }));
}

export async function searchTasks(
  db: Database,
  workspaceId: string,
  q: string,
  limit: number,
): Promise<TaskSearchHit[]> {
  const m = matcher(q);
  const present = presentation(q);
  const cand = db
    .select({
      id: tasks.id,
      title: tasks.title,
      teamId: tasks.teamId,
      stateId: tasks.stateId,
      projectId: tasks.projectId,
      updatedAt: tasks.updatedAt,
      description: tasks.description,
      body: textOf(tasks.description).as("body"),
    })
    .from(tasks)
    // Tasks of archived teams are hidden along with the team (as in the task list).
    .innerJoin(teams, and(eq(teams.id, tasks.teamId), isNull(teams.deletedAt)))
    .where(and(eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)))
    .orderBy(desc(tasks.updatedAt))
    .limit(SEARCH_CANDIDATE_LIMIT)
    .as("cand");
  const vec = vectorOf(cand.title, cand.body);
  const rows = await db
    .select()
    .from(cand)
    .where(m.where({ title: cand.title, body: cand.body, vec }))
    .orderBy(desc(m.score({ title: cand.title, vec })), desc(cand.updatedAt), cand.id)
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    teamId: r.teamId,
    stateId: r.stateId,
    projectId: r.projectId,
    updatedAt: r.updatedAt.toISOString(),
    ...present(r.title, r.description),
  }));
}

export async function search(
  db: Database,
  workspaceId: string,
  { q, scope, limit }: SearchQuery,
  /** Kinds the caller may see (module access); a hidden kind returns no hits. */
  visible: { documents: boolean; tasks: boolean } = { documents: true, tasks: true },
): Promise<SearchResponse> {
  const [docs, found] = await Promise.all([
    scope === "tasks" || !visible.documents ? [] : searchDocuments(db, workspaceId, q, limit),
    scope === "documents" || !visible.tasks ? [] : searchTasks(db, workspaceId, q, limit),
  ]);
  return { query: q, documents: docs, tasks: found };
}
