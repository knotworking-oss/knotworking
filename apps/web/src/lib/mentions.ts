import type { MentionKind } from "@knotworking/core";

/**
 * Mentions in the web app: what the `@` picker offers, how a stored mention (`kind`, `id`, cached
 * `label`) resolves against the live workspace, and where it links. Pure, so it is tested without a
 * browser; the editor and `DocRenderer` use it through `MentionChip`.
 */

/** The slice of `WorkspaceIndex` the picker and chips read (maps by id, like the sync store). */
export interface MentionSource {
  users: ReadonlyMap<string, { id: string; name: string }>;
  tasks: ReadonlyMap<string, { id: string; title: string; teamId: string; updatedAt: string }>;
  documents: ReadonlyMap<string, { id: string; title: string; icon: string | null; updatedAt: string }>;
  teams: ReadonlyMap<string, { key: string }>;
}

export interface MentionItem {
  kind: MentionKind;
  id: string;
  /** What is stored as the cache and shown in the picker. */
  label: string;
  /** Secondary text: the team key of a task, the icon of a doc. */
  hint?: string;
}

/** How many of each kind the picker lists (so a short query never drowns people in tasks). */
export const MENTION_PICKER_LIMIT = 5;

/** 0 starts with the query, 1 a word in it does, 2 it appears inside; `null` no match. */
const rank = (label: string, query: string): number | null => {
  const text = label.toLowerCase();
  if (!query || text.startsWith(query)) return 0;
  if (text.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(query))) return 1;
  return text.includes(query) ? 2 : null;
};

function top<T extends { label: string }>(items: T[], query: string, limit: number): T[] {
  return (
    items
      .flatMap((item, order) => {
        const r = rank(item.label, query);
        return r === null ? [] : [{ item, r, order }];
      })
      // Better match first; equal matches keep the caller's order (people by name, the rest newest first).
      .sort((a, b) => a.r - b.r || a.order - b.order)
      .slice(0, limit)
      .map((x) => x.item)
  );
}

const byNewest = <T extends { updatedAt: string }>(rows: Iterable<T>) =>
  [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/** People, then tasks, then documents matching `query` (case-insensitive; blank lists the first of each). */
export function filterMentionItems(
  source: MentionSource,
  rawQuery: string,
  limit = MENTION_PICKER_LIMIT,
): MentionItem[] {
  const query = rawQuery.trim().toLowerCase();
  const users = [...source.users.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((u): MentionItem => ({ kind: "user", id: u.id, label: u.name }));
  const tasks = byNewest(source.tasks.values()).map((t): MentionItem => ({
    kind: "task",
    id: t.id,
    label: t.title,
    ...(source.teams.get(t.teamId) ? { hint: source.teams.get(t.teamId)!.key } : {}),
  }));
  const docs = byNewest(source.documents.values()).map((d): MentionItem => ({
    kind: "doc",
    id: d.id,
    label: d.title.trim() || "Untitled",
    ...(d.icon ? { hint: d.icon } : {}),
  }));
  return [...top(users, query, limit), ...top(tasks, query, limit), ...top(docs, query, limit)];
}

export interface ResolvedMention {
  /** Current name or title when the target is in the workspace, else the cached label. */
  label: string;
  /** False when the target is gone (deleted, archived team, left the workspace). */
  available: boolean;
}

/** The label is only a cache: names and titles come from the live store, and a missing target is unavailable. */
export function resolveMention(
  source: MentionSource,
  mention: { kind: string; id: string; label?: string },
): ResolvedMention {
  const cached = mention.label || "";
  const gone = { label: cached, available: false };
  switch (mention.kind) {
    case "user": {
      const user = source.users.get(mention.id);
      return user ? { label: user.name, available: true } : gone;
    }
    case "task": {
      const task = source.tasks.get(mention.id);
      return task ? { label: task.title, available: true } : gone;
    }
    case "doc": {
      const doc = source.documents.get(mention.id);
      return doc ? { label: doc.title.trim() || "Untitled", available: true } : gone;
    }
    default:
      return gone;
  }
}

/** Tasks and docs have pages; people are just a chip. */
export function mentionHref(slug: string, kind: string, id: string): string | null {
  if (kind === "task") return `/${slug}/task/${id}`;
  if (kind === "doc") return `/${slug}/docs/${id}`;
  return null;
}
