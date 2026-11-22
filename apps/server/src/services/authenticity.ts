import {
  authenticityApprovalBlockers,
  authenticityControlStatus,
  authenticityDraftSchema,
  newId,
  type AuthenticityDraft,
  type AuthenticityDetail,
  type AuthenticitySummary,
  type AuthenticityVersion,
  type AuthenticityVerification,
  type AuthenticityControl,
  type AuthenticityCreateInput,
  type AuthenticitySaveInput,
  type AuthenticityVersionCommand,
  type AuthenticityApproveInput,
  type AuthenticityTriggerInput,
  type AuthenticityVerificationInput,
  type AuthenticityVoidInput,
  type AuthenticityArchiveInput,
  type AuthenticityListQuery,
} from "@knotworking/core";
import {
  authenticityAssessments as assessments,
  authenticityVersions as versions,
  authenticityTriggers as triggers,
  authenticityVerifications as verifications,
  items,
  suppliers,
  workspaceMembers,
  testingSamples,
  recordChanges,
  type Database,
  type Executor,
  type Transaction,
  type ChangeInput,
} from "@knotworking/db";
import { and, asc, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { executeLedgerCommand } from "./ledger-command";
import { workspaceToday } from "./time-zone";

type Assessment = typeof assessments.$inferSelect;
type Version = typeof versions.$inferSelect;
const change = (row: Assessment): ChangeInput => ({
  entity: "quality_authenticity",
  entityId: row.id,
  action: "upsert",
  data: { id: row.id, reference: row.reference, status: row.status, updatedAt: row.updatedAt },
});
const freshStamp = (row: Assessment) => new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
async function find(db: Executor, ws: string, id: string, stamp?: string, open = false) {
  const [row] = await db
    .select()
    .from(assessments)
    .where(and(eq(assessments.workspaceId, ws), eq(assessments.id, id)));
  if (!row) throw notFound("Authenticity assessment");
  if (open && row.status !== "active")
    throw new ApiError(
      409,
      "assessment_archived",
      "This assessment is archived; its signed history is retained",
    );
  if (stamp && row.updatedAt.toISOString() !== stamp)
    throw new ApiError(
      409,
      "assessment_changed",
      "The assessment or its evidence changed. Reload and review it before continuing.",
    );
  return row;
}
async function findVersion(db: Executor, ws: string, id: string, versionId: string) {
  const [version] = await db
    .select()
    .from(versions)
    .where(and(eq(versions.workspaceId, ws), eq(versions.assessmentId, id), eq(versions.id, versionId)));
  if (!version) throw notFound("Assessment version");
  return version;
}
async function subject(
  db: Executor,
  ws: string,
  itemId: string,
  supplierId: string | null,
  active = false,
): Promise<AuthenticityVersion["subject"]> {
  const [item] = await db
    .select()
    .from(items)
    .where(and(eq(items.workspaceId, ws), eq(items.id, itemId), isNull(items.deletedAt)));
  if (!item) throw badRequest("Choose an item from this workspace");
  if (active && item.status !== "active") throw badRequest("Review an active item");
  const [supplier] = supplierId
    ? await db
        .select()
        .from(suppliers)
        .where(and(eq(suppliers.workspaceId, ws), eq(suppliers.id, supplierId), isNull(suppliers.deletedAt)))
    : [];
  if (supplierId && !supplier) throw badRequest("Choose a supplier from this workspace");
  if (supplier && supplier.category !== "goods")
    throw badRequest(
      "Material authenticity assessments cover goods suppliers; service-provider risk remains in Supplier controls",
    );
  return {
    itemCode: item.code,
    itemName: item.name,
    supplierCode: supplier?.code ?? null,
    supplierName: supplier?.name ?? null,
  };
}
async function validateBody(db: Executor, ws: string, itemId: string, body: AuthenticityDraft) {
  const people = [
    ...new Set(
      [body.ownerUserId, ...body.controls.map((c) => c.ownerUserId)].filter((id): id is string => !!id),
    ),
  ];
  if (people.length) {
    const members = await db
      .select({ id: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ws),
          inArray(workspaceMembers.userId, people),
          isNull(workspaceMembers.deletedAt),
        ),
      );
    if (members.length !== people.length)
      throw badRequest("Assessment and control owners must be current workspace members");
  }
  const samples = [...new Set(body.evidence.flatMap((e) => (e.sampleId ? [e.sampleId] : [])))];
  if (samples.length) {
    const rows = await db
      .select({ id: testingSamples.id, itemId: testingSamples.itemId })
      .from(testingSamples)
      .where(
        and(
          eq(testingSamples.workspaceId, ws),
          inArray(testingSamples.id, samples),
          isNull(testingSamples.deletedAt),
        ),
      );
    if (rows.length !== samples.length || rows.some((r) => r.itemId !== itemId))
      throw badRequest("Linked test samples must belong to this workspace and the assessed item");
  }
}
const versionView = (v: Version): AuthenticityVersion => ({
  id: v.id,
  number: v.number,
  status: v.status,
  body: v.body,
  subject: v.subject,
  createdAt: v.createdAt.toISOString(),
  createdBy: v.createdBy,
  updatedBy: v.updatedBy,
  approvedAt: v.approvedAt?.toISOString() ?? null,
  approvedBy: v.approvedBy,
  approvalNote: v.approvalNote,
});
const verificationView = (v: typeof verifications.$inferSelect): AuthenticityVerification => ({
  id: v.id,
  versionId: v.versionId,
  controlId: v.controlId,
  verifiedOn: v.verifiedOn,
  outcome: v.outcome,
  evidenceReference: v.evidenceReference,
  evidenceValidUntil: v.evidenceValidUntil,
  note: v.note,
  createdAt: v.createdAt.toISOString(),
  actorId: v.actorId,
  voidedAt: v.voidedAt?.toISOString() ?? null,
  voidedBy: v.voidedBy,
  voidReason: v.voidReason,
});
type ControlKey = Pick<AuthenticityControl, "id" | "dueOn" | "frequencyDays">;
type SummaryBody = {
  vulnerability: AuthenticityDraft["vulnerability"];
  reviewDueOn: string | null;
  controls: ControlKey[];
  evidence: { validUntil: string | null }[];
};
function statusOf<C extends ControlKey>(
  body: { reviewDueOn: string | null; controls: C[]; evidence: { validUntil: string | null }[] } | null,
  vv: Parameters<typeof authenticityControlStatus>[1],
  today: string,
  openTriggers: number,
) {
  const controls = body?.controls.map((c) => ({ ...c, ...authenticityControlStatus(c, vv, today) })) ?? [];
  const overdueControls = controls.filter(
    (c) => c.state === "expired" || (c.nextDueOn !== null && c.nextDueOn < today),
  ).length;
  const failedControls = controls.filter((c) => c.state === "failed").length;
  const pendingControls = controls.filter((c) => c.state === "pending" || c.state === "due").length;
  const needsReview =
    !body ||
    !body.reviewDueOn ||
    body.reviewDueOn <= today ||
    openTriggers > 0 ||
    overdueControls > 0 ||
    failedControls > 0 ||
    body.evidence.some((e) => e.validUntil && e.validUntil < today);
  return { controls, overdueControls, failedControls, pendingControls, needsReview };
}
async function detail(db: Executor, ws: string, id: string, today: string): Promise<AuthenticityDetail> {
  const row = await find(db, ws, id);
  const [vr, tt, vv] = await Promise.all([
    db
      .select()
      .from(versions)
      .where(and(eq(versions.workspaceId, ws), eq(versions.assessmentId, id)))
      .orderBy(desc(versions.number)),
    db
      .select()
      .from(triggers)
      .where(and(eq(triggers.workspaceId, ws), eq(triggers.assessmentId, id)))
      .orderBy(asc(triggers.createdAt), asc(triggers.id)),
    db
      .select()
      .from(verifications)
      .where(and(eq(verifications.workspaceId, ws), eq(verifications.assessmentId, id)))
      .orderBy(asc(verifications.createdAt), asc(verifications.id)),
  ]);
  const current = vr.find((v) => v.id === row.currentVersionId),
    draft = vr.find((v) => v.id === row.draftVersionId),
    sub = current?.subject ?? draft?.subject ?? vr[0]!.subject;
  const verificationRows = vv.map(verificationView),
    openTriggers = tt.filter((t) => !t.resolvedByVersionId).length;
  const status = statusOf(
    current?.body ?? null,
    verificationRows.filter((v) => v.versionId === row.currentVersionId),
    today,
    openTriggers,
  );
  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    itemId: row.itemId,
    supplierId: row.supplierId,
    status: row.status,
    currentVersionId: row.currentVersionId,
    draftVersionId: row.draftVersionId,
    itemCode: sub.itemCode,
    itemName: sub.itemName,
    supplierName: sub.supplierName,
    vulnerability: current?.body.vulnerability ?? "unassessed",
    reviewDueOn: current?.body.reviewDueOn ?? null,
    updatedAt: row.updatedAt.toISOString(),
    openTriggers,
    ...status,
    versions: vr.map(versionView),
    triggers: tt.map((t) => ({
      id: t.id,
      kind: t.kind,
      note: t.note,
      reference: t.reference,
      createdAt: t.createdAt.toISOString(),
      actorId: t.actorId,
      resolvedByVersionId: t.resolvedByVersionId,
    })),
    verifications: verificationRows,
    approvalBlockers: draft ? authenticityApprovalBlockers(draft.body, today) : [],
    today,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    archivedBy: row.archivedBy,
    archiveReason: row.archiveReason,
  };
}
export async function getAuthenticity(db: Database, ws: string, id: string): Promise<AuthenticityDetail> {
  return db.transaction(async (tx) => detail(tx, ws, id, await workspaceToday(tx, ws)), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/** Bounded candidate scan for calculated attention filters; never silently truncates the register. */
export async function listAuthenticity(
  db: Database,
  ws: string,
  query: AuthenticityListQuery,
): Promise<{
  assessments: AuthenticitySummary[];
  total: number;
  today: string;
  limit: number;
  offset: number;
}> {
  return db.transaction(
    async (tx) => {
      const today = await workspaceToday(tx, ws),
        pattern = `%${query.q.replace(/[!%_]/g, (c) => `!${c}`)}%`;
      const rows = await tx
        .select({
          row: assessments,
          body: sql<SummaryBody | null>`case when ${versions.id} is null then null else jsonb_build_object(
      'vulnerability', ${versions.body}->'vulnerability', 'reviewDueOn', ${versions.body}->'reviewDueOn',
      'controls', coalesce((select jsonb_agg(jsonb_build_object('id', c->'id', 'dueOn', c->'dueOn', 'frequencyDays', c->'frequencyDays')) from jsonb_array_elements(${versions.body}->'controls') c), '[]'::jsonb),
      'evidence', coalesce((select jsonb_agg(jsonb_build_object('validUntil', e->'validUntil')) from jsonb_array_elements(${versions.body}->'evidence') e), '[]'::jsonb)) end`,
          subject: versions.subject,
        })
        .from(assessments)
        .leftJoin(
          versions,
          and(
            eq(versions.workspaceId, ws),
            eq(versions.id, sql`coalesce(${assessments.currentVersionId},${assessments.draftVersionId})`),
          ),
        )
        .where(
          and(
            eq(assessments.workspaceId, ws),
            query.itemId ? eq(assessments.itemId, query.itemId) : undefined,
            query.supplierId ? eq(assessments.supplierId, query.supplierId) : undefined,
            query.state === "archived"
              ? eq(assessments.status, "archived")
              : query.state !== "all"
                ? eq(assessments.status, "active")
                : undefined,
            query.q
              ? sql`(${assessments.title} ilike ${pattern} escape '!' or ${assessments.reference} ilike ${pattern} escape '!' or ${versions.subject}->>'itemCode' ilike ${pattern} escape '!' or ${versions.subject}->>'itemName' ilike ${pattern} escape '!' or ${versions.subject}->>'supplierName' ilike ${pattern} escape '!')`
              : undefined,
          ),
        )
        .orderBy(desc(assessments.updatedAt), desc(assessments.id))
        .limit(2001);
      if (rows.length > 2000)
        throw new ApiError(
          413,
          "authenticity_register_limit",
          "Refine your search: calculated authenticity registers support 2,000 matching assessments at a time",
        );
      const ids = rows.map((r) => r.row.id),
        currentIds = rows.flatMap((r) => (r.row.currentVersionId ? [r.row.currentVersionId] : []));
      const [open, verified] = await Promise.all([
        ids.length
          ? tx
              .select({ assessmentId: triggers.assessmentId, total: count() })
              .from(triggers)
              .where(
                and(
                  eq(triggers.workspaceId, ws),
                  inArray(triggers.assessmentId, ids),
                  isNull(triggers.resolvedByVersionId),
                ),
              )
              .groupBy(triggers.assessmentId)
          : [],
        currentIds.length
          ? tx
              .selectDistinctOn([verifications.versionId, verifications.controlId], {
                id: verifications.id,
                versionId: verifications.versionId,
                controlId: verifications.controlId,
                verifiedOn: verifications.verifiedOn,
                outcome: verifications.outcome,
                evidenceValidUntil: verifications.evidenceValidUntil,
                createdAt: verifications.createdAt,
              })
              .from(verifications)
              .where(
                and(
                  eq(verifications.workspaceId, ws),
                  inArray(verifications.versionId, currentIds),
                  isNull(verifications.voidedAt),
                ),
              )
              .orderBy(
                asc(verifications.versionId),
                asc(verifications.controlId),
                desc(verifications.verifiedOn),
                desc(verifications.createdAt),
                desc(verifications.id),
              )
          : [],
      ]);
      const totals = new Map(open.map((o) => [o.assessmentId, o.total]));
      const verifiedByVersion = new Map<
        string,
        Array<Parameters<typeof authenticityControlStatus>[1][number]>
      >();
      for (const v of verified) {
        const list = verifiedByVersion.get(v.versionId) ?? [];
        list.push({ ...v, createdAt: v.createdAt.toISOString(), voidedAt: null });
        verifiedByVersion.set(v.versionId, list);
      }
      const results: AuthenticitySummary[] = rows
        .map(({ row, body, subject: sub }) => {
          const current = row.currentVersionId ? body : null,
            openTriggers = totals.get(row.id) ?? 0;
          const s = statusOf(
            current,
            verifiedByVersion.get(row.currentVersionId ?? "") ?? [],
            today,
            openTriggers,
          );
          return {
            id: row.id,
            reference: row.reference,
            title: row.title,
            itemId: row.itemId,
            supplierId: row.supplierId,
            itemCode: sub?.itemCode ?? "",
            itemName: sub?.itemName ?? "",
            supplierName: sub?.supplierName ?? null,
            status: row.status,
            currentVersionId: row.currentVersionId,
            draftVersionId: row.draftVersionId,
            vulnerability: current?.vulnerability ?? "unassessed",
            reviewDueOn: current?.reviewDueOn ?? null,
            updatedAt: row.updatedAt.toISOString(),
            openTriggers,
            needsReview: s.needsReview,
            overdueControls: s.overdueControls,
            failedControls: s.failedControls,
            pendingControls: s.pendingControls,
          };
        })
        .filter((r) =>
          query.state === "needs_review"
            ? r.needsReview
            : query.state === "overdue_controls"
              ? r.overdueControls > 0
              : true,
        );
      return {
        assessments: results.slice(query.offset, query.offset + query.limit),
        total: results.length,
        today,
        limit: query.limit,
        offset: query.offset,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
async function touch(
  tx: Transaction,
  ws: string,
  actor: string,
  row: Assessment,
  patch: Partial<typeof assessments.$inferInsert> = {},
) {
  const [updated] = await tx
    .update(assessments)
    .set({ ...patch, updatedAt: freshStamp(row) })
    .where(and(eq(assessments.workspaceId, ws), eq(assessments.id, row.id)))
    .returning();
  await recordChanges(tx, ws, actor, [change(updated!)]);
  return updated!;
}
export async function createAuthenticity(
  db: Database,
  ws: string,
  actor: string,
  input: AuthenticityCreateInput,
) {
  return executeLedgerCommand(db, ws, actor, "authenticity.create", input, input, async (tx) => {
    const sub = await subject(tx, ws, input.itemId, input.supplierId, true);
    await validateBody(tx, ws, input.itemId, input.draft);
    const [existing] = await tx
      .select({ id: assessments.id })
      .from(assessments)
      .where(
        and(
          eq(assessments.workspaceId, ws),
          eq(assessments.itemId, input.itemId),
          input.supplierId ? eq(assessments.supplierId, input.supplierId) : isNull(assessments.supplierId),
          eq(assessments.status, "active"),
        ),
      );
    if (existing)
      throw new ApiError(
        409,
        "assessment_exists",
        "An active assessment already covers this item and supplier",
        { id: existing.id },
      );
    const [sequence] = await tx
      .select({ n: count() })
      .from(assessments)
      .where(eq(assessments.workspaceId, ws));
    const id = newId(),
      versionId = newId();
    const [row] = await tx
      .insert(assessments)
      .values({
        id,
        workspaceId: ws,
        title: input.title,
        itemId: input.itemId,
        supplierId: input.supplierId,
        reference: `AUTH-${String((sequence?.n ?? 0) + 1).padStart(6, "0")}`,
        draftVersionId: versionId,
        createdBy: actor,
      })
      .returning();
    await tx.insert(versions).values({
      id: versionId,
      workspaceId: ws,
      assessmentId: id,
      number: 1,
      status: "draft",
      body: input.draft,
      subject: sub,
      createdBy: actor,
      updatedBy: actor,
    });
    await recordChanges(tx, ws, actor, [change(row!)]);
    return detail(tx, ws, id, await workspaceToday(tx, ws));
  });
}
export async function startAuthenticityReview(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: AuthenticityVersionCommand,
) {
  return executeLedgerCommand(
    db,
    ws,
    actor,
    "authenticity.start_review",
    input,
    { id, ...input },
    async (tx) => {
      const row = await find(tx, ws, id, input.expectedUpdatedAt, true);
      if (row.draftVersionId) throw new ApiError(409, "draft_exists", "Continue the existing draft review");
      const previous = row.currentVersionId ? await findVersion(tx, ws, id, row.currentVersionId) : null;
      const [last] = await tx
        .select({ number: versions.number })
        .from(versions)
        .where(and(eq(versions.workspaceId, ws), eq(versions.assessmentId, id)))
        .orderBy(desc(versions.number))
        .limit(1);
      const versionId = newId();
      await tx.insert(versions).values({
        id: versionId,
        workspaceId: ws,
        assessmentId: id,
        number: (last?.number ?? 0) + 1,
        status: "draft",
        body: previous?.body ?? authenticityDraftSchema.parse({}),
        subject: await subject(tx, ws, row.itemId, row.supplierId),
        createdBy: actor,
        updatedBy: actor,
      });
      await touch(tx, ws, actor, row, { draftVersionId: versionId });
      return detail(tx, ws, id, await workspaceToday(tx, ws));
    },
  );
}
export async function saveAuthenticityDraft(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: AuthenticitySaveInput,
) {
  return executeLedgerCommand(db, ws, actor, "authenticity.save", input, { id, ...input }, async (tx) => {
    const row = await find(tx, ws, id, input.expectedUpdatedAt, true);
    if (!row.draftVersionId)
      throw new ApiError(409, "no_draft", "Start a new review before changing a signed assessment");
    const v = await findVersion(tx, ws, id, row.draftVersionId);
    if (v.status !== "draft") throw new ApiError(409, "version_immutable", "Only a draft can be edited");
    await validateBody(tx, ws, row.itemId, input.draft);
    await tx
      .update(versions)
      .set({
        body: input.draft,
        subject: await subject(tx, ws, row.itemId, row.supplierId),
        updatedBy: actor,
      })
      .where(eq(versions.id, v.id));
    await touch(tx, ws, actor, row);
    return detail(tx, ws, id, await workspaceToday(tx, ws));
  });
}
export async function approveAuthenticity(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: AuthenticityApproveInput,
) {
  return executeLedgerCommand(db, ws, actor, "authenticity.approve", input, { id, ...input }, async (tx) => {
    const row = await find(tx, ws, id, input.expectedUpdatedAt, true);
    if (!row.draftVersionId) throw badRequest("There is no draft review to sign");
    const v = await findVersion(tx, ws, id, row.draftVersionId),
      today = await workspaceToday(tx, ws);
    const blockers = authenticityApprovalBlockers(v.body, today);
    if (blockers.length)
      throw new ApiError(
        409,
        "assessment_incomplete",
        "Complete the vulnerability assessment before signing",
        blockers,
      );
    await validateBody(tx, ws, row.itemId, v.body);
    const sub = await subject(tx, ws, row.itemId, row.supplierId, true);
    const open = await tx
      .select({ id: triggers.id })
      .from(triggers)
      .where(
        and(
          eq(triggers.workspaceId, ws),
          eq(triggers.assessmentId, id),
          isNull(triggers.resolvedByVersionId),
        ),
      );
    if (open.length !== input.triggerIds.length || open.some((t) => !input.triggerIds.includes(t.id)))
      throw new ApiError(
        409,
        "triggers_changed",
        "Review every currently open trigger before signing this revision",
      );
    if (row.currentVersionId)
      await tx
        .update(versions)
        .set({ status: "superseded" })
        .where(and(eq(versions.workspaceId, ws), eq(versions.id, row.currentVersionId)));
    await tx
      .update(versions)
      .set({
        status: "approved",
        subject: sub,
        approvedAt: new Date(),
        approvedBy: actor,
        approvalNote: input.note,
      })
      .where(eq(versions.id, v.id));
    if (open.length)
      await tx
        .update(triggers)
        .set({ resolvedByVersionId: v.id })
        .where(
          and(
            eq(triggers.workspaceId, ws),
            inArray(
              triggers.id,
              open.map((t) => t.id),
            ),
          ),
        );
    await touch(tx, ws, actor, row, { currentVersionId: v.id, draftVersionId: null });
    return detail(tx, ws, id, today);
  });
}
export async function raiseAuthenticityTrigger(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: AuthenticityTriggerInput,
) {
  return executeLedgerCommand(db, ws, actor, "authenticity.trigger", input, { id, ...input }, async (tx) => {
    const row = await find(tx, ws, id, undefined, true);
    await tx.insert(triggers).values({
      workspaceId: ws,
      assessmentId: id,
      kind: input.kind,
      note: input.note,
      reference: input.reference,
      actorId: actor,
    });
    await touch(tx, ws, actor, row);
    return detail(tx, ws, id, await workspaceToday(tx, ws));
  });
}
export async function verifyAuthenticityControl(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  versionId: string,
  controlId: string,
  input: AuthenticityVerificationInput,
  manager: boolean,
) {
  return executeLedgerCommand(
    db,
    ws,
    actor,
    "authenticity.verify",
    input,
    { id, versionId, controlId, ...input },
    async (tx) => {
      const row = await find(tx, ws, id, undefined, true),
        v = await findVersion(tx, ws, id, versionId);
      if (row.currentVersionId !== v.id || v.status !== "approved")
        throw new ApiError(
          409,
          "version_not_current",
          "Verify controls against the current signed assessment",
        );
      const control = v.body.controls.find((c) => c.id === controlId);
      if (!control) throw notFound("Authenticity control");
      if (!manager && control.ownerUserId !== actor)
        throw new ApiError(
          403,
          "control_owner_required",
          "Only the assigned control owner or a Quality manager may record this verification",
        );
      const today = await workspaceToday(tx, ws);
      if (input.verifiedOn > today || input.verifiedOn < (await workspaceToday(tx, ws, v.approvedAt!)))
        throw badRequest("Verification must be dated between this revision's approval and today");
      const verificationId = newId();
      await tx.insert(verifications).values({
        id: verificationId,
        workspaceId: ws,
        assessmentId: id,
        versionId,
        controlId,
        verifiedOn: input.verifiedOn,
        outcome: input.outcome,
        evidenceReference: input.evidenceReference,
        evidenceValidUntil: input.evidenceValidUntil,
        note: input.note,
        actorId: actor,
      });
      if (input.outcome === "fail")
        await tx.insert(triggers).values({
          workspaceId: ws,
          assessmentId: id,
          kind: "failed_control",
          note: `${control.description}: ${input.note}`,
          reference: `Verification ${verificationId}: ${input.evidenceReference}`,
          actorId: actor,
        });
      await touch(tx, ws, actor, row);
      return detail(tx, ws, id, today);
    },
  );
}
export async function voidAuthenticityVerification(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  verificationId: string,
  input: AuthenticityVoidInput,
) {
  return executeLedgerCommand(
    db,
    ws,
    actor,
    "authenticity.verification.void",
    input,
    { id, verificationId, ...input },
    async (tx) => {
      const row = await find(tx, ws, id);
      const [v] = await tx
        .select()
        .from(verifications)
        .where(
          and(
            eq(verifications.workspaceId, ws),
            eq(verifications.assessmentId, id),
            eq(verifications.id, verificationId),
          ),
        );
      if (!v) throw notFound("Control verification");
      if (v.voidedAt)
        throw new ApiError(409, "verification_voided", "This verification is already corrected");
      await tx
        .update(verifications)
        .set({ voidedAt: new Date(), voidedBy: actor, voidReason: input.reason })
        .where(eq(verifications.id, v.id));
      if (row.status === "active" && row.currentVersionId === v.versionId)
        await tx.insert(triggers).values({
          workspaceId: ws,
          assessmentId: id,
          kind: "evidence_correction",
          note: input.reason,
          reference: `Corrected verification ${verificationId}`,
          actorId: actor,
        });
      await touch(tx, ws, actor, row);
      return detail(tx, ws, id, await workspaceToday(tx, ws));
    },
  );
}
export async function archiveAuthenticity(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: AuthenticityArchiveInput,
) {
  return executeLedgerCommand(db, ws, actor, "authenticity.archive", input, { id, ...input }, async (tx) => {
    const row = await find(tx, ws, id, input.expectedUpdatedAt, true);
    await touch(tx, ws, actor, row, {
      status: "archived",
      archivedAt: new Date(),
      archivedBy: actor,
      archiveReason: input.reason,
    });
    return detail(tx, ws, id, await workspaceToday(tx, ws));
  });
}
