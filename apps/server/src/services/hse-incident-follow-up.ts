import {
  hseDaysSince,
  hseIncidentActionState,
  hseYearAgo,
  newId,
  type HseIncidentActionComplete,
  type HseIncidentActionCreate,
  type HseIncidentBody,
  type HseInjuriesSave,
  type HseReport,
} from "@knotworking/core";
import {
  hseIncidentActions as actions,
  hseIncidentInjuries as injuries,
  hseIncidents as incidents,
  staff,
  users,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { executeLedgerCommand } from "./ledger-command";
import { audience, memberAccess } from "./notifications";
import { auditHseIncident, findHseIncident, validateHseIncidentBody } from "./hse-incidents";
import { workspaceToday } from "./time-zone";

/**
 * Follow-up to the restricted incidents of milestone 3.4.3 (`hse_incidents`): owned corrective
 * actions, the people hurt, low-barrier reports and the overview.
 *
 * - The people hurt and the incident's free-text health details are restricted beyond the module:
 *   only `canSeeRestricted` readers (a signed-in `hse_incidents` manager; the routes decide) get
 *   them, in the incident, its saves and its history. Others see `injuryCount`.
 * - Every action or people-hurt change advances the incident's revision and is recorded in its
 *   history, so a closure signed against a revision covers the actions as they then stood.
 * - Nothing here is written to the sync log: like the incidents, these records are private.
 */

const conflict = (message: string) => new ApiError(409, "hse_conflict", message);
type IncidentRow = typeof incidents.$inferSelect;
type ActionRow = typeof actions.$inferSelect;

const RESTRICTED_NOTE = "Restricted: only Restricted HSE incident managers see health details";

/** An incident body as the reader may see it: the free-text health details hidden unless allowed. */
export function bodyForReader(body: HseIncidentBody, canSeeRestricted: boolean): HseIncidentBody {
  if (canSeeRestricted) return { ...body, outcome: body.outcome ?? "none" };
  return {
    ...body,
    outcome: body.outcome ?? "none",
    healthDetails: body.healthDetails ? RESTRICTED_NOTE : "",
  };
}

/** An incident row (or a history snapshot of one) as the reader may see it. */
export function incidentForReader<T extends { body?: unknown }>(row: T, canSeeRestricted: boolean): T {
  if (!row.body) return row;
  return { ...row, body: bodyForReader(row.body as HseIncidentBody, canSeeRestricted) };
}

async function bump(tx: Transaction, row: IncidentRow) {
  await tx
    .update(incidents)
    .set({ revision: row.revision + 1, updatedAt: new Date() })
    .where(eq(incidents.id, row.id));
}

async function openIncident(tx: Executor, ws: string, id: string, expectedRevision: number) {
  const row = await findHseIncident(tx, ws, id);
  if (row.revision !== expectedRevision) throw conflict("The incident changed; reload and review it");
  if (row.status !== "open") throw conflict("Closed investigations are immutable");
  return row;
}

/** Members who can work on restricted incidents (write or above) — action owners must be one. */
async function assertIncidentWorker(tx: Executor, ws: string, userId: string) {
  const workers = audience(await memberAccess(tx, ws), "hse_incidents", "write");
  if (!workers.includes(userId))
    throw badRequest("The action owner must have Restricted HSE incidents access to see the action");
}

async function names(db: Executor, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (!wanted.length) return new Map<string, string>();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** The follow-up parts of an incident: actions for everyone with access, the people hurt only if allowed. */
export async function incidentFollowUp(
  db: Executor,
  ws: string,
  incidentId: string,
  options: { canSeeRestricted: boolean; today: string },
) {
  const actionRows = await db
    .select()
    .from(actions)
    .where(and(eq(actions.incidentId, incidentId), eq(actions.workspaceId, ws), isNull(actions.deletedAt)))
    .orderBy(asc(actions.dueOn), asc(actions.createdAt));
  const people = await db
    .select()
    .from(injuries)
    .where(and(eq(injuries.incidentId, incidentId), eq(injuries.workspaceId, ws), isNull(injuries.deletedAt)))
    .orderBy(asc(injuries.createdAt));
  const who = await names(
    db,
    actionRows.flatMap((a) => [a.ownerUserId, a.completedBy]),
  );
  const openActions = actionRows.filter((a) => a.status === "open").length;
  return {
    injuryCount: people.length,
    injuries: options.canSeeRestricted
      ? people.map(({ workspaceId: _ws, deletedAt: _d, incidentId: _i, ...rest }) => rest)
      : null,
    actions: actionRows.map(({ workspaceId: _ws, deletedAt: _d, ...a }) => ({
      ...a,
      state: hseIncidentActionState(a, options.today),
      ownerName: a.ownerUserId ? (who.get(a.ownerUserId) ?? null) : null,
      completedByName: a.completedBy ? (who.get(a.completedBy) ?? null) : null,
    })),
    openActions,
  };
}

/** How many people are recorded as hurt (live rows). */
export async function injuredCount(db: Executor, ws: string, incidentId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(injuries)
    .where(
      and(eq(injuries.workspaceId, ws), eq(injuries.incidentId, incidentId), isNull(injuries.deletedAt)),
    );
  return Number(row?.n ?? 0);
}

/** The history reason non-managers see for a people-hurt change: the manager's own words may name people. */
export const PEOPLE_HURT_REASON_HIDDEN = "People hurt updated (the reason is restricted)";

/** Open corrective actions on an incident (closure refuses while there are any). */
export async function openActionCount(db: Executor, ws: string, incidentId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(actions)
    .where(
      and(
        eq(actions.workspaceId, ws),
        eq(actions.incidentId, incidentId),
        eq(actions.status, "open"),
        isNull(actions.deletedAt),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * What needs attention among restricted incidents: open ones, those without a reporting decision,
 * overdue actions, days since the last lost-time or major injury, and the last twelve months by kind.
 */
export async function hseIncidentOverview(db: Executor, ws: string, today: string) {
  const live = eq(incidents.workspaceId, ws);
  const occurred = sql<string>`${incidents.body}->>'occurredOn'`;
  const open = await db
    .select({
      id: incidents.id,
      reference: incidents.reference,
      kind: sql<string>`${incidents.body}->>'kind'`,
      occurredOn: occurred,
      decision: sql<string>`${incidents.body}->>'reportingDecision'`,
    })
    .from(incidents)
    .where(and(live, eq(incidents.status, "open")))
    .orderBy(sql`${occurred} desc`);
  const byKind = await db
    .select({ kind: sql<string>`${incidents.body}->>'kind'`, n: count() })
    .from(incidents)
    .where(and(live, gte(occurred, hseYearAgo(today))))
    .groupBy(sql`${incidents.body}->>'kind'`);
  const [lost] = await db
    .select({ on: sql<string | null>`max(${occurred})` })
    .from(incidents)
    .where(and(live, sql`${incidents.body}->>'outcome' in ('lost_time', 'major')`));
  const overdue = await db
    .select({ action: actions, reference: incidents.reference, ownerName: users.name })
    .from(actions)
    .innerJoin(incidents, eq(incidents.id, actions.incidentId))
    .leftJoin(users, eq(users.id, actions.ownerUserId))
    .where(
      and(
        eq(actions.workspaceId, ws),
        isNull(actions.deletedAt),
        eq(actions.status, "open"),
        sql`${actions.dueOn} < ${today}`,
      ),
    )
    .orderBy(asc(actions.dueOn));
  return {
    today,
    counts: {
      open: open.length,
      decisionsPending: open.filter((r) => r.decision === "not_assessed").length,
      overdueActions: overdue.length,
    },
    daysSinceLostTime: hseDaysSince(lost?.on ?? null, today),
    lastYearByKind: Object.fromEntries(byKind.map((k) => [k.kind, Number(k.n)])),
    decisionsPending: open.filter((r) => r.decision === "not_assessed").map(({ decision: _d, ...r }) => r),
    overdueActions: overdue.map((o) => ({
      id: o.action.id,
      incidentId: o.action.incidentId,
      reference: o.reference,
      description: o.action.description,
      dueOn: o.action.dueOn,
      ownerName: o.ownerName,
    })),
  };
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/** Adds a corrective action (`hse_incidents` write) against the revision the person reviewed. */
export async function addIncidentAction(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: HseIncidentActionCreate,
) {
  return executeLedgerCommand(
    db,
    ws,
    actor,
    "hse.incident.action.add",
    input,
    { id, ...input },
    async (tx) => {
      const row = await openIncident(tx, ws, id, input.expectedRevision);
      await assertIncidentWorker(tx, ws, input.ownerUserId);
      await tx.insert(actions).values({
        workspaceId: ws,
        incidentId: id,
        description: input.description,
        ownerUserId: input.ownerUserId,
        dueOn: input.dueOn,
        createdBy: actor,
      });
      await bump(tx, row);
      return auditHseIncident(tx, ws, actor, id, "action_added", input.description);
    },
  );
}

/** Completes (owner or manager) or cancels (manager) an action, with a note. A signed-in person. */
export async function completeIncidentAction(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  actionId: string,
  input: HseIncidentActionComplete,
  options: { isManager: boolean },
) {
  return executeLedgerCommand(
    db,
    ws,
    actor,
    "hse.incident.action.complete",
    input,
    { id, actionId, ...input },
    async (tx) => {
      const row = await openIncident(tx, ws, id, input.expectedRevision);
      const [action] = await tx
        .select()
        .from(actions)
        .where(
          and(
            eq(actions.id, actionId),
            eq(actions.incidentId, id),
            eq(actions.workspaceId, ws),
            isNull(actions.deletedAt),
          ),
        );
      if (!action) throw notFound("Action");
      if (action.status !== "open") throw conflict(`This action is already ${action.status}`);
      if (action.ownerUserId !== actor && !options.isManager)
        throw new ApiError(403, "not_action_owner", "Only the action's owner or a manager can complete it");
      if (input.status === "cancelled" && !options.isManager)
        throw new ApiError(403, "not_manager", "Only a manager can cancel an action");
      await tx
        .update(actions)
        .set({
          status: input.status,
          completedBy: actor,
          completedAt: new Date(),
          completionNote: input.note,
        })
        .where(eq(actions.id, actionId));
      await bump(tx, row);
      return auditHseIncident(
        tx,
        ws,
        actor,
        id,
        input.status === "done" ? "action_done" : "action_cancelled",
        `${action.description}: ${input.note}`,
      );
    },
  );
}

/**
 * Replaces the people hurt and sets the worst outcome in one step (a signed-in manager). Replaced
 * entries are kept (soft-deleted). The history records that they changed, never who or how.
 */
export async function saveIncidentInjuries(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: HseInjuriesSave,
) {
  return executeLedgerCommand(db, ws, actor, "hse.incident.injuries", input, { id, ...input }, async (tx) => {
    const row = await openIncident(tx, ws, id, input.expectedRevision);
    if (input.injuries.length && (row.body.kind === "near_miss" || row.body.kind === "unsafe_condition"))
      throw badRequest("A near miss or unsafe condition has no one hurt; change its kind first");
    for (const injury of input.injuries) {
      if (!injury.staffId) continue;
      const [s] = await tx
        .select({ id: staff.id })
        .from(staff)
        .where(and(eq(staff.workspaceId, ws), eq(staff.id, injury.staffId), isNull(staff.deletedAt)));
      if (!s) throw badRequest("A person hurt must be a People record in this workspace");
    }
    await tx
      .update(injuries)
      .set({ deletedAt: new Date() })
      .where(and(eq(injuries.incidentId, id), isNull(injuries.deletedAt)));
    if (input.injuries.length)
      await tx
        .insert(injuries)
        .values(input.injuries.map((i) => ({ ...i, workspaceId: ws, incidentId: id, recordedBy: actor })));
    await tx
      .update(incidents)
      .set({
        body: { ...row.body, outcome: input.outcome },
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(incidents.id, id));
    return auditHseIncident(tx, ws, actor, id, "people_hurt_updated", input.reason);
  });
}

/**
 * Reports an incident in which nobody was hurt (HSE `write`; an agent's token too, reported as its
 * owner). It becomes a restricted incident owned by the reporter until an investigator reassigns
 * it (the reporter may have no Restricted HSE incidents access, so can't see it), and only its id
 * and reference are returned.
 */
export async function reportHseIncident(db: Database, ws: string, actor: string, input: HseReport) {
  return executeLedgerCommand(db, ws, actor, "hse.report", input, input, async (tx) => {
    const today = await workspaceToday(tx, ws);
    if (input.occurredOn > today) throw badRequest("An incident cannot occur in the future");
    const body: HseIncidentBody = {
      kind: input.kind,
      occurredOn: input.occurredOn,
      place: input.place,
      summary: input.summary,
      staffIds: [],
      healthDetails: "",
      immediateActions: input.immediateActions || "Not recorded at report",
      ownerUserId: actor,
      investigation: "",
      rootCause: "",
      correctiveActions: "",
      effectiveness: "",
      reportingDecision: "not_assessed",
      reportingBasis: "",
      reportingDueOn: null,
      reportReference: "",
      outcome: "none",
    };
    await validateHseIncidentBody(tx, ws, body);
    const id = newId();
    const reference = `HSE-${id.slice(-12)}`;
    await tx.insert(incidents).values({ workspaceId: ws, id, reference, body, createdBy: actor });
    await auditHseIncident(tx, ws, actor, id, "reported", "Reported without health details");
    return { id, reference };
  });
}

export type { ActionRow };
