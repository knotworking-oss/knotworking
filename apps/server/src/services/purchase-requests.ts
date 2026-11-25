import {
  hasModuleLevel,
  type ModuleId,
  type PurchaseRequestCreateInput,
  type PurchaseRequestDecisionInput,
  type PurchaseRequestListQuery,
} from "@knotworking/core";
import { purchaseRequests, type Database, type Executor } from "@knotworking/db";
import { and, desc, eq, lt } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { executeLedgerCommand } from "./ledger-command";
import {
  insertNotifications,
  memberAccess,
  type NotificationRow,
  type NotifiedCallback,
} from "./notifications";

type Viewer = { id: string; canManage: boolean };
type RequestRow = typeof purchaseRequests.$inferSelect;

function viewRequest(row: RequestRow) {
  const { workspaceId: _workspaceId, ...request } = row;
  return request;
}

async function loadRequest(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(purchaseRequests)
    .where(and(eq(purchaseRequests.workspaceId, workspaceId), eq(purchaseRequests.id, id)));
  if (!row) throw notFound("Purchase request");
  return row;
}

async function approverIds(db: Executor, workspaceId: string, active: readonly ModuleId[], actorId: string) {
  const access = await memberAccess(db, workspaceId, active);
  return [...access]
    .filter(([id, levels]) => id !== actorId && hasModuleLevel(levels.purchase_requests, "manage"))
    .map(([id]) => id);
}

export async function listPurchaseRequests(
  db: Database,
  workspaceId: string,
  active: readonly ModuleId[],
  viewer: Viewer,
  query: PurchaseRequestListQuery,
) {
  if (query.view === "all" && !viewer.canManage)
    throw new ApiError(403, "forbidden", "Only purchase request managers can view all requests");
  const roleFilter =
    query.view === "mine"
      ? eq(purchaseRequests.requesterId, viewer.id)
      : query.view === "assigned"
        ? eq(purchaseRequests.approverId, viewer.id)
        : undefined;
  const pageSize = 50;
  const rows = await db
    .select()
    .from(purchaseRequests)
    .where(
      and(
        eq(purchaseRequests.workspaceId, workspaceId),
        roleFilter,
        query.status ? eq(purchaseRequests.status, query.status) : undefined,
        query.before ? lt(purchaseRequests.id, query.before) : undefined,
      ),
    )
    .orderBy(desc(purchaseRequests.id))
    .limit(pageSize + 1);
  const page = rows.slice(0, pageSize);
  return {
    requests: page.map(viewRequest),
    nextCursor: rows.length > pageSize ? page.at(-1)!.id : null,
    approverIds: await approverIds(db, workspaceId, active, viewer.id),
  };
}

export async function getPurchaseRequest(db: Database, workspaceId: string, viewer: Viewer, id: string) {
  const row = await loadRequest(db, workspaceId, id);
  if (!viewer.canManage && viewer.id !== row.requesterId && viewer.id !== row.approverId) {
    throw notFound("Purchase request");
  }
  return viewRequest(row);
}

export async function submitPurchaseRequest(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  currency: string,
  input: PurchaseRequestCreateInput,
  onNotified: NotifiedCallback,
) {
  let notified: NotificationRow[] = [];
  const request = await executeLedgerCommand(
    db,
    workspaceId,
    actorId,
    "purchase_requests.submit",
    input,
    input,
    async (tx) => {
      if (input.currency !== currency)
        throw new ApiError(
          409,
          "currency_changed",
          "The workspace currency changed. Reload the form and check the amount",
        );
      if (!(await approverIds(tx, workspaceId, active, actorId)).includes(input.approverId)) {
        throw badRequest("Choose another active member who can approve purchase requests");
      }
      const { commandId: _commandId, ...fields } = input;
      const [row] = await tx
        .insert(purchaseRequests)
        .values({ ...fields, workspaceId, requesterId: actorId })
        .returning();
      notified = await insertNotifications(tx, workspaceId, actorId, [
        {
          userId: input.approverId,
          type: "purchase_request_submitted",
          module: "purchase_requests",
          data: { subjectId: row!.id },
        },
      ]);
      return viewRequest(row!);
    },
  );
  if (notified.length) onNotified(notified);
  return request;
}

export async function decidePurchaseRequest(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: PurchaseRequestDecisionInput,
  onNotified: NotifiedCallback,
) {
  let notified: NotificationRow[] = [];
  const request = await executeLedgerCommand(
    db,
    workspaceId,
    actorId,
    "purchase_requests.decide",
    input,
    { id, ...input },
    async (tx) => {
      const row = await loadRequest(tx, workspaceId, id);
      const withdrawal = input.status === "withdrawn";
      if (withdrawal ? row.requesterId !== actorId : row.approverId !== actorId) {
        throw notFound("Purchase request");
      }
      if (row.status !== "pending")
        throw new ApiError(409, "already_decided", "This purchase request is already closed");
      const [saved] = await tx
        .update(purchaseRequests)
        .set({
          status: input.status,
          decidedBy: actorId,
          decidedAt: new Date(),
          decisionNote: input.note || null,
        })
        .where(and(eq(purchaseRequests.workspaceId, workspaceId), eq(purchaseRequests.id, id)))
        .returning();
      if (!withdrawal && row.requesterId) {
        notified = await insertNotifications(tx, workspaceId, actorId, [
          {
            userId: row.requesterId,
            type: "purchase_request_decided",
            module: "purchase_requests",
            data: { subjectId: id, stateName: input.status },
          },
        ]);
      }
      return viewRequest(saved!);
    },
  );
  if (notified.length) onNotified(notified);
  return request;
}
