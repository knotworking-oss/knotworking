import {
  canApproveReleaseException,
  evaluateLotRelease,
  exceptionCovers,
  moduleIds,
  releaseBlockers,
  type LotReleaseExceptionRequestInput,
  type ModuleAccessMap,
  type ModuleId,
} from "@knotworking/core";
import {
  lockWorkspaceLog,
  lotReleaseExceptionRequests,
  recordChanges,
  stockLots,
  users,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ApiError, notFound } from "../errors";
import { assertNoIncidentHold } from "./incident-holds";
import { forReader, gatherReleaseFacts, recordRelease } from "./lot-release";
import { audience, memberAccess } from "./notifications";
import { findLot, getLot, lotChange } from "./ports/stock";

/**
 * Release exceptions (closing a 3.2.3 gap): a blocked lot is released only when two people with
 * stock `manage` agree. One requests the exception with the release note, reason and evidence;
 * another approves it, which releases the lot under the workspace lock, or rejects it. The
 * requester can approve only when nobody else has stock `manage`, and the release says so.
 *
 * The request keeps the checks it was made against and the lot's status. An approval re-runs the
 * check and is refused if anything now blocks that wasn't shown then, down to the samples and
 * records each blocker names, if the rule changed, or if the lot's status changed, so nobody
 * approves a release against blockers they weren't shown or of a lot someone has since rejected. Requests are read through the lot's endpoints, never synced;
 * each change records the lot so clients refresh it.
 */

type RequestRow = typeof lotReleaseExceptionRequests.$inferSelect;

async function pendingRequest(tx: Executor, workspaceId: string, lotId: string, requestId: string) {
  const [row] = await tx
    .select()
    .from(lotReleaseExceptionRequests)
    .where(
      and(
        eq(lotReleaseExceptionRequests.id, requestId),
        eq(lotReleaseExceptionRequests.workspaceId, workspaceId),
        eq(lotReleaseExceptionRequests.lotId, lotId),
      ),
    );
  if (!row) throw notFound("Release exception request");
  if (row.status !== "pending")
    throw new ApiError(409, "exception_not_pending", `This request was already ${row.status}`);
  return row;
}

async function decide(
  tx: Transaction,
  row: RequestRow,
  actorId: string,
  status: RequestRow["status"],
  note: string | null,
) {
  await tx
    .update(lotReleaseExceptionRequests)
    .set({ status, decidedBy: actorId, decidedAt: new Date(), decisionNote: note })
    .where(eq(lotReleaseExceptionRequests.id, row.id));
}

async function touchLot(tx: Transaction, workspaceId: string, actorId: string, lotId: string) {
  const { lot } = await findLot(tx, workspaceId, lotId);
  await recordChanges(tx, workspaceId, actorId, [lotChange(lot)]);
}

const decider = alias(users, "exception_decider");

/** A lot's exception requests, newest first, with the checks as the reader may see them. */
export async function listReleaseExceptions(
  db: Executor,
  workspaceId: string,
  lotId: string,
  access: ModuleAccessMap,
) {
  await findLot(db, workspaceId, lotId);
  const rows = await db
    .select({
      request: lotReleaseExceptionRequests,
      requestedByName: users.name,
      decidedByName: decider.name,
    })
    .from(lotReleaseExceptionRequests)
    .leftJoin(users, eq(users.id, lotReleaseExceptionRequests.requestedBy))
    .leftJoin(decider, eq(decider.id, lotReleaseExceptionRequests.decidedBy))
    .where(
      and(
        eq(lotReleaseExceptionRequests.workspaceId, workspaceId),
        eq(lotReleaseExceptionRequests.lotId, lotId),
      ),
    )
    .orderBy(desc(lotReleaseExceptionRequests.requestedAt));
  return {
    requests: rows.map(({ request, requestedByName, decidedByName }) => {
      const { workspaceId: _ws, ...rest } = request;
      return { ...rest, checks: forReader(request.checks, access), requestedByName, decidedByName };
    }),
  };
}

/** Asks for a blocked lot to be released as an exception. A person with stock `manage`. */
export async function requestReleaseException(
  db: Database,
  workspaceId: string,
  actorId: string,
  lotId: string,
  input: LotReleaseExceptionRequestInput,
  options: { active?: readonly ModuleId[]; access: ModuleAccessMap },
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const { lot } = await findLot(tx, workspaceId, lotId);
    if (lot.status === "available") throw new ApiError(409, "lot_available", "This lot is already released");
    await assertNoIncidentHold(tx, workspaceId, lotId);
    const facts = await gatherReleaseFacts(tx, workspaceId, lot, options.active ?? moduleIds);
    const evaluation = evaluateLotRelease(facts);
    if (!evaluation.blocked)
      throw new ApiError(409, "exception_not_needed", "Nothing blocks this release; release the lot instead");
    const [pending] = await tx
      .select({ id: lotReleaseExceptionRequests.id })
      .from(lotReleaseExceptionRequests)
      .where(
        and(eq(lotReleaseExceptionRequests.lotId, lotId), eq(lotReleaseExceptionRequests.status, "pending")),
      );
    if (pending)
      throw new ApiError(
        409,
        "exception_pending",
        "A release exception is already waiting for approval on this lot",
      );
    await tx.insert(lotReleaseExceptionRequests).values({
      workspaceId,
      lotId,
      note: input.note,
      reason: input.reason,
      evidence: input.evidence,
      ruleVersion: evaluation.ruleVersion,
      checks: evaluation.checks,
      lotStatus: lot.status,
      lotStatusChangedAt: lot.statusChangedAt,
      requestedBy: actorId,
    });
    await touchLot(tx, workspaceId, actorId, lotId);
  });
  return listReleaseExceptions(db, workspaceId, lotId, options.access);
}

/**
 * Approves a pending request and releases the lot. Another person with stock `manage` than the
 * requester, unless the requester is the only one. Refused (and the request superseded) when the
 * lot's status changed at all since the request (released, rejected, held again), when blockers
 * or records appeared that the request didn't cover, or when nothing blocks any more (release it
 * normally then).
 */
export async function approveReleaseException(
  db: Database,
  workspaceId: string,
  actorId: string,
  lotId: string,
  requestId: string,
  input: { note?: string },
  options: { active?: readonly ModuleId[] },
) {
  const active = options.active ?? moduleIds;
  const outcome = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const row = await pendingRequest(tx, workspaceId, lotId, requestId);
    const managers = audience(await memberAccess(tx, workspaceId, active), "stock", "manage");
    const who = canApproveReleaseException({
      requestedBy: row.requestedBy,
      deciderId: actorId,
      managerIds: managers,
    });
    if (!who.allowed)
      throw new ApiError(
        403,
        "four_eyes",
        "You requested this exception, so another person with stock manage access must approve it",
      );
    const { lot } = await findLot(tx, workspaceId, lotId);
    await assertNoIncidentHold(tx, workspaceId, lotId);
    // Any status change since the request (released, rejected, held again) makes it stale:
    // `setLotStatus` closes pending requests too, this is the backstop.
    const sameStatus =
      lot.status === row.lotStatus &&
      (lot.statusChangedAt?.getTime() ?? null) === (row.lotStatusChangedAt?.getTime() ?? null);
    if (!sameStatus || lot.status === "available") {
      await decide(tx, row, actorId, "superseded", "The lot's status changed since the request");
      await touchLot(tx, workspaceId, actorId, lotId);
      return {
        stale: `This lot's status changed since the exception was requested (now ${lot.status}); the request is closed`,
      } as const;
    }
    const facts = await gatherReleaseFacts(tx, workspaceId, lot, active);
    const evaluation = evaluateLotRelease(facts);
    if (!evaluation.blocked) {
      await decide(tx, row, actorId, "superseded", "Nothing blocks the release any more");
      await touchLot(tx, workspaceId, actorId, lotId);
      return { stale: "Nothing blocks this release any more; release the lot normally" } as const;
    }
    if (!exceptionCovers(row, evaluation)) {
      await decide(tx, row, actorId, "superseded", "The release check changed since it was requested");
      await touchLot(tx, workspaceId, actorId, lotId);
      return {
        stale: `The release check changed since this exception was requested (now: ${releaseBlockers(evaluation).join("; ")}). Request a new exception against what blocks it now.`,
      } as const;
    }
    await recordRelease(tx, workspaceId, actorId, {
      lotId,
      fromStatus: lot.status,
      note: input.note ? `${row.note}\nApproval: ${input.note}` : row.note,
      evaluation,
      rule: facts.rule,
      exception: {
        requestId: row.id,
        requestedBy: row.requestedBy,
        reason: row.reason,
        evidence: row.evidence,
        selfApproved: who.selfApproved,
      },
    });
    await decide(tx, row, actorId, "approved", input.note ?? null);
    const [updated] = await tx
      .update(stockLots)
      .set({
        status: "available",
        statusChangedAt: new Date(),
        statusChangedBy: actorId,
        statusNote: row.note,
      })
      .where(eq(stockLots.id, lotId))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [lotChange(updated!)]);
    return { lot: await getLot(tx, workspaceId, lotId) } as const;
  });
  // A stale request is closed in its own committed transaction, then reported.
  if (!outcome.lot) throw new ApiError(409, "exception_stale", outcome.stale);
  return outcome.lot;
}

/** Rejects a pending request (another manager), or withdraws it (the requester). A reason is required. */
export async function rejectReleaseException(
  db: Database,
  workspaceId: string,
  actorId: string,
  lotId: string,
  requestId: string,
  input: { note: string },
  access: ModuleAccessMap,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const row = await pendingRequest(tx, workspaceId, lotId, requestId);
    await decide(tx, row, actorId, row.requestedBy === actorId ? "withdrawn" : "rejected", input.note);
    await touchLot(tx, workspaceId, actorId, lotId);
  });
  return listReleaseExceptions(db, workspaceId, lotId, access);
}
