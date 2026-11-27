import {
  hasModuleLevel,
  priorityKeys,
  type ModuleId,
  type Priority,
  type TokenActionId,
} from "@knotworking/core";
import { ToolError, type Api } from "./api";

/**
 * How many tasks the API's bootstrap returns at most (`listTasks(…, { limit: 5000 })` in
 * apps/server/src/services/workspace.ts). A snapshot with exactly this many tasks may be missing some, so
 * never treat `bootstrap.tasks` as complete or look a single task up in it.
 */
export const BOOTSTRAP_TASK_CAP = 5000;

/** The largest `limit` `GET …/tasks` accepts (`taskListQuerySchema` in @knotworking/core). */
export const TASK_LIST_MAX = 500;

/**
 * Fetches the normalised workspace snapshot the name -> id lookups are built from. Memoized per request
 * when the `Api` is (HTTP mode), so several tool calls in one batch share one fetch.
 */
export async function fetchBootstrap(api: Api, slug: string) {
  return api.memo(`bootstrap:${slug}`, () =>
    api.call(api.client.v1.workspaces[":slug"].bootstrap.$get({ param: { slug } })),
  );
}

/** `/v1/me`: the caller and their workspaces. Memoized like the bootstrap. */
export function fetchMe(api: Api) {
  return api.memo("me", () => api.call(api.client.v1.me.$get()));
}

/**
 * The modules whose tools to offer this caller: active in this environment (`active`, from
 * `KNOTWORKING_MODULES`) and readable by the token's user in the workspace the tools will default
 * to (`defaultWorkspace`, else the user's only workspace). With several workspaces and no default,
 * or when the API can't be asked, it falls back to `active`: the tool list is a convenience, the
 * API refuses what the user may not do.
 */
export async function visibleModules(
  api: Api,
  options: ListingOptions & { active: readonly ModuleId[] },
): Promise<ModuleId[]> {
  try {
    const slug = await (options.workspace ?? listingWorkspace(api, options.defaultWorkspace));
    if (!slug) return [...options.active];
    const { modules } = await api.call(api.client.v1.workspaces[":slug"].modules.$get({ param: { slug } }));
    const readable = new Set(modules.filter((m) => hasModuleLevel(m.access, "read")).map((m) => m.id));
    return options.active.filter((id) => readable.has(id));
  } catch {
    return [...options.active];
  }
}

interface ListingOptions {
  defaultWorkspace?: string | undefined;
  /** The listing workspace when already being looked up (see `toolListing`), so `/me` is read once. */
  workspace?: Promise<string | undefined>;
}

/**
 * What shapes a tool list: `visibleModules` and `enabledTokenActions`, fetched side by side and
 * sharing one lookup of the listing workspace.
 */
export async function toolListing(
  api: Api,
  options: { active: readonly ModuleId[]; defaultWorkspace?: string | undefined },
): Promise<{ modules: ModuleId[]; tokenActions: TokenActionId[] }> {
  const workspace = listingWorkspace(api, options.defaultWorkspace);
  const [modules, tokenActions] = await Promise.all([
    visibleModules(api, { ...options, workspace }),
    enabledTokenActions(api, { ...options, workspace }),
  ]);
  return { modules, tokenActions };
}

/** The workspace the tool list is shaped for: the default, else the user's only one (else none). */
async function listingWorkspace(api: Api, defaultWorkspace: string | undefined) {
  if (defaultWorkspace) return defaultWorkspace;
  const { workspaces } = await fetchMe(api);
  return workspaces.length === 1 ? workspaces[0]!.slug : undefined;
}

/**
 * The person-only actions an owner or admin has opened to API tokens (Settings -> API access) in the
 * workspace the tools will default to. The tools that need one are listed only while it is enabled and the token's own allowlist includes it.
 * Unlike `visibleModules` this fails closed: with several workspaces and no default, or when the API
 * can't be asked, nothing is enabled and the gated tools stay hidden. The API refuses a disabled
 * action on every call regardless, so this only shapes the tool list.
 */
export async function enabledTokenActions(api: Api, options: ListingOptions): Promise<TokenActionId[]> {
  try {
    const slug = await (options.workspace ?? listingWorkspace(api, options.defaultWorkspace));
    if (!slug) return [];
    const { actions } = await api.call(
      api.client.v1.workspaces[":slug"]["token-actions"].$get({ param: { slug } }),
    );
    // Both the workspace and this token's own allowlist must allow it (older servers send no flag).
    return actions.filter((a) => a.enabled && a.allowedForToken !== false).map((a) => a.id);
  } catch {
    return [];
  }
}

export type Bootstrap = Awaited<ReturnType<typeof fetchBootstrap>>;
export type TaskRow = Bootstrap["tasks"][number];
export type UserRow = Bootstrap["users"][number];
export type TeamRow = Bootstrap["teams"][number];
export type StateRow = Bootstrap["workflowStates"][number];
export type LabelRow = Bootstrap["labels"][number];
export type ProjectRow = Bootstrap["projects"][number];
export type DocumentRow = Bootstrap["documents"][number];

/** Workspace data with the lookups the tools need. Built once per tool call. */
export class Model {
  readonly usersById: Map<string, UserRow>;
  readonly teamsById: Map<string, TeamRow>;
  readonly statesById: Map<string, StateRow>;
  readonly labelsById: Map<string, LabelRow>;
  readonly projectsById: Map<string, ProjectRow>;

  constructor(readonly data: Bootstrap) {
    this.usersById = new Map(data.users.map((u) => [u.id, u]));
    this.teamsById = new Map(data.teams.map((t) => [t.id, t]));
    this.statesById = new Map(data.workflowStates.map((s) => [s.id, s]));
    this.labelsById = new Map(data.labels.map((l) => [l.id, l]));
    this.projectsById = new Map(data.projects.map((p) => [p.id, p]));
  }

  get slug() {
    return this.data.workspace.slug;
  }

  /** True when the snapshot's task list hit the server's cap, so tasks may be missing from it. */
  get tasksMayBeTruncated() {
    return this.data.tasks.length >= BOOTSTRAP_TASK_CAP;
  }

  // ── name -> id ──

  team(ref: string): TeamRow {
    return pick(
      this.data.teams,
      ref,
      (t) => [t.key, t.name],
      "team",
      (t) => `${t.key} (${t.name})`,
    );
  }

  state(team: TeamRow, ref: string): StateRow {
    const states = this.data.workflowStates.filter((s) => s.teamId === team.id);
    try {
      return pick(
        states,
        ref,
        (s) => [s.name],
        "workflow state",
        (s) => `${s.name} [${s.type}]`,
        `in team ${team.key}`,
      );
    } catch (err) {
      // "completed" / "started" … when the team has exactly one state of that type.
      const byType = states.filter((s) => s.type === ref.trim().toLowerCase());
      if (err instanceof ToolError && err.code === "not_found" && byType.length === 1) return byType[0]!;
      throw err;
    }
  }

  /**
   * A task by id or exact (case-insensitive) title. Only the snapshot is searched, which is capped at
   * `BOOTSTRAP_TASK_CAP` tasks, so in a huge workspace pass the id. A well-formed id is not looked up at
   * all (the API checks it), so tasks outside the snapshot still work by id.
   */
  taskRef(ref: string): { id: string; title: string | null } {
    const wanted = ref.trim();
    if (UUID.test(wanted)) {
      const known = this.data.tasks.find((t) => t.id.toLowerCase() === wanted.toLowerCase());
      return { id: wanted, title: known?.title ?? null };
    }
    const byReference = this.data.tasks.find((task) => task.reference === wanted.toUpperCase());
    if (byReference) return { id: byReference.id, title: byReference.title };
    const matches = this.data.tasks.filter((t) => t.title.trim().toLowerCase() === wanted.toLowerCase());
    if (matches.length === 1) return { id: matches[0]!.id, title: matches[0]!.title };
    if (matches.length > 1)
      throw new ToolError(
        "ambiguous",
        `More than one task is titled "${ref}" (ids: ${matches
          .slice(0, 10)
          .map((t) => t.id)
          .join(", ")}). Use a task id instead.`,
      );
    throw new ToolError(
      "not_found",
      `No task is titled "${ref}". Pass a task id (from list_tasks or search_tasks) or an exact title.`,
    );
  }

  /** The title of a task in the snapshot (null when it is not there: deleted, or beyond the snapshot cap). */
  taskTitle(id: string): string | null {
    return this.data.tasks.find((t) => t.id === id)?.title ?? null;
  }

  document(ref: string): DocumentRow {
    return pick(
      this.data.documents,
      ref,
      (d) => [d.title],
      "document",
      (d) => d.title || "(untitled)",
    );
  }

  /** `me` is the caller's own user id (from `/v1/me`), supplied lazily because it costs a request. */
  async member(ref: string, meId: () => Promise<string>): Promise<UserRow> {
    const wanted = ref.trim().toLowerCase() === "me" ? await meId() : ref;
    return pick(
      this.data.users,
      wanted,
      (u) => [u.email, u.name],
      "member",
      (u) => `${u.name} <${u.email || "email hidden"}>`,
    );
  }

  project(ref: string): ProjectRow {
    return pick(
      this.data.projects,
      ref,
      (p) => [p.name],
      "project",
      (p) => p.name,
    );
  }

  /** Labels usable on a task of `team`: workspace-wide ones plus the team's own (team-scoped wins on a tie). */
  labels(team: TeamRow, refs: string[]): LabelRow[] {
    const usable = this.data.labels.filter((l) => !l.teamId || l.teamId === team.id);
    const out: LabelRow[] = [];
    for (const ref of refs) {
      const wanted = ref.trim().toLowerCase();
      const named = usable.filter((l) => l.name.toLowerCase() === wanted);
      const scoped = named.filter((l) => l.teamId === team.id);
      const chosen = scoped.length === 1 ? scoped : named;
      const label = chosen.length
        ? pick(
            chosen,
            ref,
            (l) => [l.name],
            "label",
            (l) => l.name,
          )
        : pick(
            usable,
            ref,
            (l) => [l.name],
            "label",
            (l) => l.name,
            `for team ${team.key}`,
          );
      if (!out.some((l) => l.id === label.id)) out.push(label);
    }
    return out;
  }

  // ── id -> name ──

  userName(id: string | null | undefined) {
    return id ? (this.usersById.get(id)?.name ?? null) : null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_OPTIONS_SHOWN = 20;

/** Finds `ref` by id, then by case-insensitive exact match on `keys`. Errors list the valid options. */
function pick<T extends { id: string }>(
  items: T[],
  ref: string,
  keys: (item: T) => string[],
  what: string,
  describe: (item: T) => string,
  where = "",
): T {
  const wanted = ref.trim().toLowerCase();
  const byId = items.find((i) => i.id.toLowerCase() === wanted);
  if (byId) return byId;
  const matches = items.filter((i) => keys(i).some((k) => k && k.toLowerCase() === wanted));
  if (matches.length === 1) return matches[0]!;
  const options = (list: T[]) =>
    list.slice(0, MAX_OPTIONS_SHOWN).map(describe).join(", ") +
    (list.length > MAX_OPTIONS_SHOWN ? `, … (${list.length} total)` : "");
  if (matches.length > 1)
    throw new ToolError(
      "ambiguous",
      `More than one ${what} matches "${ref}": ${options(matches)}. Use its id instead.`,
    );
  throw new ToolError(
    "not_found",
    `No ${what} matches "${ref}"${where ? ` ${where}` : ""}. Available: ${options(items) || "none"}.`,
  );
}

// ── compact wire shapes ──

export const priorityName = (p: number) => priorityKeys[p as Priority] ?? String(p);

export function summarizeTask(model: Model, t: TaskRow) {
  const state = model.statesById.get(t.stateId);
  return {
    id: t.id,
    reference: t.reference ?? null,
    title: t.title,
    team: model.teamsById.get(t.teamId)?.key ?? null,
    state: state?.name ?? null,
    stateType: state?.type ?? null,
    priority: priorityName(t.priority),
    assignee: model.userName(t.assigneeId),
    project: t.projectId ? (model.projectsById.get(t.projectId)?.name ?? null) : null,
    labels: t.labelIds.map((id) => model.labelsById.get(id)?.name).filter((n): n is string => Boolean(n)),
    startDate: t.startDate ?? null,
    dueDate: t.dueDate ?? null,
    estimateMinutes: t.estimateMinutes ?? null,
    parentId: t.parentId ?? null,
    updatedAt: t.updatedAt,
  };
}

/** `teamIds` overrides the snapshot's team links (a project just written is not in the snapshot yet). */
export function summarizeProject(
  model: Model,
  p: Omit<ProjectRow, "deletedAt" | "workspaceId">,
  teamIds?: string[],
) {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    health: p.health ?? null,
    lead: model.userName(p.leadId),
    startDate: p.startDate ?? null,
    targetDate: p.targetDate ?? null,
    teams: (teamIds ?? model.data.projectTeams.filter((pt) => pt.projectId === p.id).map((pt) => pt.teamId))
      .map((teamId) => model.teamsById.get(teamId)?.key)
      .filter((k): k is string => Boolean(k)),
    description: p.description ?? null,
  };
}

export function summarizeDocument(model: Model, d: DocumentRow) {
  return {
    id: d.id,
    title: d.title || "(untitled)",
    parentId: d.parentId ?? null,
    team: d.teamId ? (model.teamsById.get(d.teamId)?.key ?? null) : null,
    project: d.projectId ? (model.projectsById.get(d.projectId)?.name ?? null) : null,
    updatedAt: d.updatedAt,
  };
}
