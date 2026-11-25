import {
  hsePermitCloseSchema,
  hseApprovalBlockers,
  hseDue,
  addDays,
  newId,
  roundQuantity,
  type ModuleId,
  type HseCreate,
  type HseSave,
  type HseAction,
  type HseContent,
  type HsePage,
  type HseList,
  type HseEntry,
  type HsePermitCreate,
  type HsePermitSave,
  type HsePermitClose,
  type HsePermitSign,
} from "@knotworking/core";
import {
  hseRecords as records,
  hseVersions as versions,
  hseEntries as entries,
  hsePermits as permits,
  hsePermitEvents as permitEvents,
  siteAssets,
  suppliers,
  workspaceMembers,
  trainingCourses,
  attachments,
  tasks,
  attendanceVisits,
  recordChanges,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, eq, asc, desc, isNull, inArray, count, sql } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { executeLedgerCommand } from "./ledger-command";
import { workspaceToday } from "./time-zone";
import { checkSupplierControls } from "./supplier-controls";
import { permitCompetence } from "./ports/training";
export const hsePublic = <T extends { workspaceId: string }>({ workspaceId: _ws, ...row }: T) => row;
const conflict = (message: string) => new ApiError(409, "hse_conflict", message);
const change = (entity: "hse_record" | "hse_entry" | "hse_permit", id: string, revision?: number) => ({
  entity,
  entityId: id,
  action: "upsert" as const,
  data: { id, ...(revision ? { revision } : {}) },
});
export async function hseMember(db: Executor, ws: string, id: string) {
  const [m] = await db
    .select({ id: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ws),
        eq(workspaceMembers.userId, id),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  if (!m) throw badRequest("Choose a current member of this workspace");
}
function reviewed(row: { revision: number }, expected: number) {
  if (row.revision !== expected)
    throw conflict("This record changed. Reload and review the current revision.");
}
async function recordOf(db: Executor, ws: string, id: string) {
  const [row] = await db
    .select()
    .from(records)
    .where(and(eq(records.workspaceId, ws), eq(records.id, id)));
  if (!row) throw notFound("HSE register");
  return row;
}
async function currentVersion(db: Executor, ws: string, id: string, status: "draft" | "approved") {
  const [v] = await db
    .select()
    .from(versions)
    .where(and(eq(versions.workspaceId, ws), eq(versions.recordId, id), eq(versions.status, status)));
  return v;
}
async function liveRecord(db: Executor, ws: string, id: string, through: string) {
  const r = await recordOf(db, ws, id);
  const v = await currentVersion(db, ws, id, "approved");
  if (r.status !== "active" || !v || !v.content.reviewDueOn || v.content.reviewDueOn < through)
    throw conflict("An active signed assessment, current through the work, is required");
  return { record: r, version: v };
}
async function validateContent(db: Executor, ws: string, id: string | null, c: HseContent, sign = false) {
  if (c.ownerUserId) await hseMember(db, ws, c.ownerUserId);
  for (const id of c.actionTaskIds ?? []) {
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, ws), eq(tasks.id, id), isNull(tasks.deletedAt)));
    if (!task) throw badRequest("Follow-up tasks must belong to this workspace");
  }
  if (c.supplierId) {
    const [s] = await db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.workspaceId, ws), eq(suppliers.id, c.supplierId), isNull(suppliers.deletedAt)));
    if (!s || s.category !== "service") throw badRequest("Choose an existing service provider in Items");
    if (sign && s.approvalStatus !== "approved") throw conflict("The service provider must be approved");
  }
  for (const courseId of c.courseIds) {
    const [course] = await db
      .select({ id: trainingCourses.id })
      .from(trainingCourses)
      .where(
        and(
          eq(trainingCourses.workspaceId, ws),
          eq(trainingCourses.id, courseId),
          eq(trainingCourses.status, "active"),
          isNull(trainingCourses.deletedAt),
        ),
      );
    if (!course) throw badRequest("Choose active courses from this workspace's training matrix");
  }
  if (c.sdsAttachmentId) {
    const [file] = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.workspaceId, ws),
          eq(attachments.id, c.sdsAttachmentId),
          eq(attachments.entityType, "hse_record"),
          id ? eq(attachments.entityId, id) : sql`false`,
          isNull(attachments.deletedAt),
        ),
      );
    if (!file) throw badRequest("The SDS file must be attached to this HSE record");
  }
}
async function attention(
  db: Executor,
  ws: string,
  record: typeof records.$inferSelect,
  approved: typeof versions.$inferSelect | undefined,
  today: string,
) {
  const [latest] = await db
    .select({ performedOn: entries.performedOn, nextDueOn: entries.nextDueOn })
    .from(entries)
    .where(
      and(
        eq(entries.workspaceId, ws),
        eq(entries.recordId, record.id),
        approved ? eq(entries.versionId, approved.id) : sql`false`,
        isNull(entries.voidedAt),
      ),
    )
    .orderBy(desc(entries.performedOn), desc(entries.createdAt), desc(entries.id))
    .limit(1);
  const [failures] = await db
    .select({ n: count() })
    .from(entries)
    .where(
      and(
        eq(entries.workspaceId, ws),
        eq(entries.recordId, record.id),
        eq(entries.outcome, "fail"),
        isNull(entries.voidedAt),
        sql`not exists(select 1 from hse_entries resolution where resolution.workspace_id=${ws} and resolution.resolves_entry_id=${entries.id} and resolution.voided_at is null)`,
      ),
    );
  return {
    reviewOverdue: !!approved?.content.reviewDueOn && approved.content.reviewDueOn < today,
    openFailures: failures!.n,
    ...hseDue(
      approved?.content.firstCheckDueOn ?? null,
      approved?.content.frequencyDays ?? null,
      latest ?? null,
      today,
    ),
  };
}
/**
 * The names behind a register's references, for the evidence view: the service provider and the
 * required training courses (workspace-scoped; a missing one simply isn't named).
 */
export async function contentReferences(
  db: Executor,
  ws: string,
  contents: (HseContent | null | undefined)[],
  readProviders = true,
) {
  const supplierIds = [...new Set(contents.map((c) => c?.supplierId).filter((v): v is string => !!v))];
  const courseIds = [...new Set(contents.flatMap((c) => c?.courseIds ?? []))];
  const [providerRows, courseRows] = await Promise.all([
    readProviders && supplierIds.length
      ? db
          .select({ id: suppliers.id, name: suppliers.name, code: suppliers.code })
          .from(suppliers)
          .where(and(eq(suppliers.workspaceId, ws), inArray(suppliers.id, supplierIds)))
      : Promise.resolve([]),
    courseIds.length
      ? db
          .select({ id: trainingCourses.id, title: trainingCourses.title, code: trainingCourses.code })
          .from(trainingCourses)
          .where(and(eq(trainingCourses.workspaceId, ws), inArray(trainingCourses.id, courseIds)))
      : Promise.resolve([]),
  ]);
  return {
    suppliers: Object.fromEntries(providerRows.map((s) => [s.id, s.code ? `${s.name} (${s.code})` : s.name])),
    courses: Object.fromEntries(courseRows.map((c) => [c.id, `${c.code} · ${c.title}`])),
  };
}
export async function getHseRecord(db: Database, ws: string, id: string, readProviders: boolean) {
  return db.transaction(
    async (tx) => {
      const record = await recordOf(tx, ws, id);
      const [draft, approved] = await Promise.all([
        currentVersion(tx, ws, id, "draft"),
        currentVersion(tx, ws, id, "approved"),
      ]);
      return {
        ...hsePublic(record),
        draft: draft ? hsePublic(draft) : null,
        approved: approved ? hsePublic(approved) : null,
        attention: await attention(tx, ws, record, approved, await workspaceToday(tx, ws)),
        references: await contentReferences(tx, ws, [draft?.content, approved?.content], readProviders),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function listHseRecords(db: Database, ws: string, q: HseList) {
  const where = and(
    eq(records.workspaceId, ws),
    eq(records.status, q.status),
    q.kind ? eq(records.kind, q.kind) : undefined,
  );
  return db.transaction(
    async (tx) => {
      const rows = await tx
        .select()
        .from(records)
        .where(where)
        .orderBy(asc(records.title), asc(records.id))
        .limit(q.limit)
        .offset(q.offset);
      const [total] = await tx.select({ n: count() }).from(records).where(where);
      const today = await workspaceToday(tx, ws);
      const result = [];
      for (const row of rows) {
        const approved = await currentVersion(tx, ws, row.id, "approved");
        result.push({
          ...hsePublic(row),
          approvedVersion: approved?.number ?? null,
          attention: await attention(tx, ws, row, approved, today),
        });
      }
      return { records: result, total: total!.n, limit: q.limit, offset: q.offset };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function createHseRecord(db: Database, ws: string, actor: string, input: HseCreate) {
  return executeLedgerCommand(db, ws, actor, "hse.create", input, input, async (tx) => {
    await validateContent(tx, ws, null, input.content);
    const [row] = await tx
      .insert(records)
      .values({ workspaceId: ws, title: input.title, kind: input.kind, createdBy: actor })
      .returning();
    await tx.insert(versions).values({
      workspaceId: ws,
      recordId: row!.id,
      number: 1,
      content: input.content,
      reason: "Initial draft",
      createdBy: actor,
    });
    await recordChanges(tx, ws, actor, [change("hse_record", row!.id, 1)]);
    return hsePublic(row!);
  });
}
export async function saveHseDraft(db: Database, ws: string, actor: string, id: string, input: HseSave) {
  return executeLedgerCommand(db, ws, actor, "hse.draft", input, { id, ...input }, async (tx) => {
    const r = await recordOf(tx, ws, id);
    reviewed(r, input.expectedRevision);
    if (r.status !== "active") throw conflict("This register is archived");
    const draft = await currentVersion(tx, ws, id, "draft");
    if (!draft) throw conflict("Start a review before editing a signed record");
    await validateContent(tx, ws, id, input.content);
    await tx
      .update(versions)
      .set({ content: input.content, reason: input.reason })
      .where(eq(versions.id, draft.id));
    await tx
      .update(records)
      .set({ revision: r.revision + 1, updatedAt: new Date() })
      .where(eq(records.id, id));
    await recordChanges(tx, ws, actor, [change("hse_record", id, r.revision + 1)]);
    return { id, revision: r.revision + 1 };
  });
}
export async function actHseRecord(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: HseAction,
  action: "approve" | "review" | "archive",
  readProviders = true,
) {
  return executeLedgerCommand(db, ws, actor, `hse.${action}`, input, { id, ...input }, async (tx) => {
    const r = await recordOf(tx, ws, id);
    reviewed(r, input.expectedRevision);
    if (r.status !== "active") throw conflict("This register is archived");
    const [draft, approved] = await Promise.all([
      currentVersion(tx, ws, id, "draft"),
      currentVersion(tx, ws, id, "approved"),
    ]);
    if (action === "approve") {
      if (!draft) throw conflict("No draft to approve");
      if (draft.content.supplierId && !readProviders) {
        throw new ApiError(
          403,
          "module_forbidden",
          "Items read access is required to review this service provider",
        );
      }
      const blockers = hseApprovalBlockers(r.kind, draft.content, await workspaceToday(tx, ws));
      if (blockers.length) throw new ApiError(409, "hse_incomplete", blockers.join("; "));
      await validateContent(tx, ws, id, draft.content, true);
      if (approved)
        await tx.update(versions).set({ status: "superseded" }).where(eq(versions.id, approved.id));
      await tx
        .update(versions)
        .set({ status: "approved", approvedBy: actor, approvedAt: new Date(), reason: input.reason })
        .where(eq(versions.id, draft.id));
    }
    if (action === "review") {
      if (draft || !approved) throw conflict("A signed record with no open draft is required");
      await tx.insert(versions).values({
        workspaceId: ws,
        recordId: id,
        number: approved.number + 1,
        content: approved.content,
        reason: input.reason,
        createdBy: actor,
      });
    }
    if (action === "archive") {
      const previous = approved ?? draft;
      if (!previous) throw conflict("No assessment content to archive");
      await tx.insert(versions).values({
        workspaceId: ws,
        recordId: id,
        number: Math.max(approved?.number ?? 0, draft?.number ?? 0) + 1,
        status: "archived",
        content: previous.content,
        reason: input.reason,
        approvedBy: actor,
        approvedAt: new Date(),
        createdBy: actor,
      });
    }
    await tx
      .update(records)
      .set({
        revision: r.revision + 1,
        updatedAt: new Date(),
        ...(action === "archive" ? { status: "archived" as const } : {}),
      })
      .where(eq(records.id, id));
    await recordChanges(tx, ws, actor, [change("hse_record", id, r.revision + 1)]);
    return { id, revision: r.revision + 1 };
  });
}
export async function hseHistory(db: Database, ws: string, id: string, q: HsePage, readProviders: boolean) {
  await recordOf(db, ws, id);
  const where = and(eq(versions.workspaceId, ws), eq(versions.recordId, id));
  const [rows, [total]] = await Promise.all([
    db.select().from(versions).where(where).orderBy(desc(versions.number)).limit(q.limit).offset(q.offset),
    db.select({ n: count() }).from(versions).where(where),
  ]);
  return {
    versions: rows.map(hsePublic),
    references: await contentReferences(
      db,
      ws,
      rows.map((r) => r.content),
      readProviders,
    ),
    total: total!.n,
    ...q,
  };
}
export async function listHseEntries(db: Database, ws: string, id: string, q: HsePage) {
  await recordOf(db, ws, id);
  const where = and(eq(entries.workspaceId, ws), eq(entries.recordId, id));
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(entries)
      .where(where)
      .orderBy(desc(entries.performedOn), desc(entries.createdAt), desc(entries.id))
      .limit(q.limit)
      .offset(q.offset),
    db.select({ n: count() }).from(entries).where(where),
  ]);
  return { entries: rows.map(hsePublic), total: total!.n, ...q };
}
export async function createHseEntry(db: Database, ws: string, actor: string, id: string, input: HseEntry) {
  return executeLedgerCommand(db, ws, actor, "hse.entry", input, { id, ...input }, async (tx) => {
    const r = await recordOf(tx, ws, id);
    reviewed(r, input.expectedRevision);
    const { version } = await liveRecord(tx, ws, id, await workspaceToday(tx, ws));
    const today = await workspaceToday(tx, ws);
    if (input.performedOn > today || (input.nextDueOn && input.nextDueOn < input.performedOn))
      throw badRequest("Check the performed and next due dates");
    if (["waste", "utility"].includes(r.kind)) {
      if (input.quantity === null) throw badRequest("Record a positive measured quantity");
      if (r.kind === "utility" && !input.periodFrom)
        throw badRequest("Record the start of this resource-use period");
      if (input.outcome !== "recorded")
        throw badRequest("Resource and waste quantities use the recorded outcome");
    } else if (input.outcome === "recorded") throw badRequest("A verification needs a pass/fail outcome");
    if (input.resolvesEntryId) {
      const [failed] = await tx
        .select()
        .from(entries)
        .where(
          and(
            eq(entries.workspaceId, ws),
            eq(entries.recordId, id),
            eq(entries.id, input.resolvesEntryId),
            eq(entries.outcome, "fail"),
            isNull(entries.voidedAt),
          ),
        );
      if (!failed || input.outcome !== "pass" || input.performedOn < failed.performedOn || !input.actions)
        throw badRequest("Resolve a live failure with a later passing verification and action evidence");
      const [resolved] = await tx
        .select({ id: entries.id })
        .from(entries)
        .where(
          and(eq(entries.workspaceId, ws), eq(entries.resolvesEntryId, failed.id), isNull(entries.voidedAt)),
        );
      if (resolved) throw conflict("This failure is already resolved");
    }
    const { commandId: _c, expectedRevision: _r, ...values } = input;
    const [row] = await tx
      .insert(entries)
      .values({
        ...values,
        quantity: input.quantity === null ? null : roundQuantity(input.quantity),
        unit: version.content.unit || null,
        workspaceId: ws,
        recordId: id,
        versionId: version.id,
        recordedBy: actor,
      })
      .returning();
    await tx
      .update(records)
      .set({ revision: r.revision + 1, updatedAt: new Date() })
      .where(eq(records.id, id));
    await recordChanges(tx, ws, actor, [
      change("hse_entry", row!.id),
      change("hse_record", id, r.revision + 1),
    ]);
    return hsePublic(row!);
  });
}
export async function voidHseEntry(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  entryId: string,
  input: HseAction,
) {
  return executeLedgerCommand(
    db,
    ws,
    actor,
    "hse.entry.void",
    input,
    { id, entryId, ...input },
    async (tx) => {
      const r = await recordOf(tx, ws, id);
      reviewed(r, input.expectedRevision);
      const [entry] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.workspaceId, ws), eq(entries.recordId, id), eq(entries.id, entryId)));
      if (!entry) throw notFound("HSE entry");
      if (entry.voidedAt) throw conflict("Already corrected");
      const [resolving] = await tx
        .select({ id: entries.id })
        .from(entries)
        .where(
          and(eq(entries.workspaceId, ws), eq(entries.resolvesEntryId, entryId), isNull(entries.voidedAt)),
        );
      if (resolving) throw conflict("Correct its resolving verification first");
      await tx
        .update(entries)
        .set({ voidedAt: new Date(), voidedBy: actor, voidReason: input.reason })
        .where(eq(entries.id, entryId));
      await tx
        .update(records)
        .set({ revision: r.revision + 1, updatedAt: new Date() })
        .where(eq(records.id, id));
      await recordChanges(tx, ws, actor, [
        change("hse_entry", entryId),
        change("hse_record", id, r.revision + 1),
      ]);
      return { id: entryId };
    },
  );
}

async function assetOf(db: Executor, ws: string, id: string) {
  const [a] = await db
    .select({ id: siteAssets.id, name: siteAssets.name, status: siteAssets.status })
    .from(siteAssets)
    .where(and(eq(siteAssets.workspaceId, ws), eq(siteAssets.id, id), isNull(siteAssets.deletedAt)));
  if (!a) throw notFound("Site asset");
  return a;
}
async function permitOf(db: Executor, ws: string, id: string) {
  const [p] = await db
    .select()
    .from(permits)
    .where(and(eq(permits.workspaceId, ws), eq(permits.id, id)));
  if (!p) throw notFound("Permit");
  return p;
}
async function validatePermitLinks(db: Executor, ws: string, b: typeof permits.$inferSelect.body) {
  await assetOf(db, ws, b.assetId);
  const c = await recordOf(db, ws, b.contractorRecordId);
  if (c.kind !== "contractor") throw badRequest("Choose a contractor competence record");
  for (const id of b.assessmentIds) {
    const r = await recordOf(db, ws, id);
    if (!["risk_assessment", "coshh"].includes(r.kind)) throw badRequest("Choose risk or COSHH assessments");
  }
  if (b.staffId) {
    await permitCompetence(db, ws, b.staffId, [], await workspaceToday(db, ws), b.endsOn);
  }
  if (b.visitId) {
    const [v] = await db
      .select({ id: attendanceVisits.id })
      .from(attendanceVisits)
      .where(
        and(
          eq(attendanceVisits.workspaceId, ws),
          eq(attendanceVisits.id, b.visitId),
          isNull(attendanceVisits.deletedAt),
        ),
      );
    if (!v) throw notFound("Visitor sign-in");
  }
}
async function permitSnapshot(
  tx: Transaction,
  ws: string,
  actor: string,
  id: string,
  action: string,
  reason: string,
  decision?: Record<string, unknown>,
) {
  const row = await permitOf(tx, ws, id);
  await tx.insert(permitEvents).values({
    workspaceId: ws,
    permitId: id,
    revision: row.revision,
    action,
    reason,
    actorId: actor,
    snapshot: JSON.parse(JSON.stringify({ ...hsePublic(row), ...(decision ? { decision } : {}) })),
  });
  await recordChanges(tx, ws, actor, [change("hse_permit", id, row.revision)]);
  return hsePublic(row);
}
export async function createHsePermit(db: Database, ws: string, actor: string, input: HsePermitCreate) {
  return executeLedgerCommand(db, ws, actor, "hse.permit.create", input, input, async (tx) => {
    await validatePermitLinks(tx, ws, input.body);
    const [r] = await tx
      .insert(permits)
      .values({
        workspaceId: ws,
        title: input.title,
        body: input.body,
        assetId: input.body.assetId,
        isolationRequired: input.body.isolationRequired,
        createdBy: actor,
      })
      .returning();
    return permitSnapshot(tx, ws, actor, r!.id, "created", "Draft prepared");
  });
}
export async function saveHsePermit(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: HsePermitSave,
) {
  return executeLedgerCommand(db, ws, actor, "hse.permit.save", input, { id, ...input }, async (tx) => {
    const r = await permitOf(tx, ws, id);
    reviewed(r, input.expectedRevision);
    if (r.status !== "draft")
      throw conflict("Only draft permits may change; close and replace an issued permit");
    await validatePermitLinks(tx, ws, input.body);
    await tx
      .update(permits)
      .set({
        body: input.body,
        assetId: input.body.assetId,
        isolationRequired: input.body.isolationRequired,
        revision: r.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(permits.id, id));
    return permitSnapshot(tx, ws, actor, id, "edited", input.reason);
  });
}
async function issueEvidence(
  tx: Transaction,
  ws: string,
  b: typeof permits.$inferSelect.body,
  active: readonly ModuleId[],
) {
  const today = await workspaceToday(tx, ws);
  if (b.startsOn > today || b.endsOn < today) throw conflict("The permit is outside its working dates");
  if (!b.inductionChecked || !b.ppeChecked || !b.emergencyReady)
    throw conflict("Confirm induction, PPE and emergency arrangements");
  const asset = await assetOf(tx, ws, b.assetId);
  if (asset.status !== "active") throw conflict("The asset is archived");
  const contractor = await liveRecord(tx, ws, b.contractorRecordId, b.endsOn);
  if (
    !contractor.version.content.competenceExpiresOn ||
    contractor.version.content.competenceExpiresOn < b.endsOn
  )
    throw conflict("Contractor competence expires before the work ends");
  await validateContent(tx, ws, contractor.record.id, contractor.version.content, true);
  if ((await attention(tx, ws, contractor.record, contractor.version, today)).openFailures)
    throw conflict("Resolve failed contractor checks before authorising work");
  await checkSupplierControls(tx, ws, contractor.version.content.supplierId!, "order", {
    active,
    today,
    override: undefined,
    overrideAllowed: false,
  });
  const [provider] = await tx
    .select({
      id: suppliers.id,
      name: suppliers.name,
      reviewDueOn: suppliers.reviewDueOn,
      certificateExpiresOn: suppliers.certificateExpiresOn,
    })
    .from(suppliers)
    .where(eq(suppliers.id, contractor.version.content.supplierId!));
  if (
    (provider?.reviewDueOn && provider.reviewDueOn < b.endsOn) ||
    (provider?.certificateExpiresOn && provider.certificateExpiresOn < b.endsOn)
  )
    throw conflict("Service-provider approval evidence expires before the work ends");
  const assessments = [];
  let hasRisk = false;
  for (const id of b.assessmentIds) {
    const a = await liveRecord(tx, ws, id, b.endsOn);
    if (a.record.kind === "risk_assessment") hasRisk = true;
    await validateContent(tx, ws, id, a.version.content, true);
    if ((await attention(tx, ws, a.record, a.version, today)).openFailures)
      throw conflict("Resolve failed assessment checks before authorising work");
    assessments.push({ id, versionId: a.version.id, number: a.version.number, content: a.version.content });
  }
  if (!hasRisk) throw conflict("A signed risk assessment is required");
  const required = contractor.version.content.courseIds;
  if (required.length && !b.staffId)
    throw conflict("Select the registered worker whose required training must be checked");
  const competence = b.staffId ? await permitCompetence(tx, ws, b.staffId, required, today, b.endsOn) : null;
  if (b.visitId) {
    const [visit] = await tx
      .select({ id: attendanceVisits.id, signedOutAt: attendanceVisits.signedOutAt })
      .from(attendanceVisits)
      .where(
        and(
          eq(attendanceVisits.workspaceId, ws),
          eq(attendanceVisits.id, b.visitId),
          isNull(attendanceVisits.deletedAt),
        ),
      );
    if (!visit || visit.signedOutAt) throw conflict("The linked contractor visit is no longer on site");
  }
  return {
    asset,
    provider,
    contractor: {
      id: contractor.record.id,
      versionId: contractor.version.id,
      content: contractor.version.content,
    },
    assessments,
    competence,
    visitId: b.visitId,
  };
}
/** The approved contractor and assessment versions a permit would be signed against now. */
async function permitEvidenceVersions(db: Executor, ws: string, b: typeof permits.$inferSelect.body) {
  const contractor = await currentVersion(db, ws, b.contractorRecordId, "approved");
  const assessments = [];
  for (const id of b.assessmentIds) {
    const record = await recordOf(db, ws, id);
    const v = await currentVersion(db, ws, id, "approved");
    assessments.push({ id, title: record.title, versionId: v?.id ?? null, number: v?.number ?? null });
  }
  return {
    contractorVersionId: contractor?.id ?? null,
    contractorVersionNumber: contractor?.number ?? null,
    assessments,
  };
}
export async function actHsePermit(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: HseAction | HsePermitClose,
  action: "issue" | "suspend" | "resume" | "close" | "cancel",
  attendanceAllowed = false,
  active: readonly ModuleId[] = [],
) {
  return executeLedgerCommand(db, ws, actor, `hse.permit.${action}`, input, { id, ...input }, async (tx) => {
    const p = await permitOf(tx, ws, id);
    reviewed(p, input.expectedRevision);
    if (action === "close" && !hsePermitCloseSchema.safeParse(input).success)
      throw badRequest("Every return-to-service assertion must be signed");
    const allowed = {
      issue: ["draft"],
      suspend: ["issued"],
      resume: ["suspended"],
      close: ["issued", "suspended"],
      cancel: ["draft"],
    };
    if (!allowed[action].includes(p.status))
      throw conflict("This permit is not in a valid state for the decision");
    if ((action === "issue" || action === "resume") && p.body.visitId && !attendanceAllowed)
      throw new ApiError(403, "module_forbidden", "Attendance read access is required for this linked visit");
    if (action === "issue" || action === "resume") {
      // Bind the signature to the evidence versions the manager reviewed (shown on the permit).
      const reviewedEvidence = (input as Partial<HsePermitSign>).reviewedEvidence;
      const now = await permitEvidenceVersions(tx, ws, p.body);
      const same = (a: readonly (string | null)[], b: readonly string[]) =>
        a.length === b.length && a.every((v, i) => v === b[i]);
      if (
        !reviewedEvidence ||
        now.contractorVersionId !== reviewedEvidence.contractorVersionId ||
        !same(
          now.assessments.map((x) => x.versionId),
          reviewedEvidence.assessmentVersionIds,
        )
      )
        throw new ApiError(
          409,
          "evidence_changed",
          "The contractor or assessment versions changed since you reviewed this permit. Reload and review them before signing.",
        );
    }
    const evidence =
      action === "issue" || action === "resume"
        ? await issueEvidence(tx, ws, p.body, active)
        : p.evidenceSnapshot;
    const status = {
      issue: "issued",
      suspend: "suspended",
      resume: "issued",
      close: "closed",
      cancel: "cancelled",
    } as const;
    await tx
      .update(permits)
      .set({
        status: status[action],
        evidenceSnapshot: JSON.parse(JSON.stringify(evidence)),
        revision: p.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(permits.id, id));
    return permitSnapshot(
      tx,
      ws,
      actor,
      id,
      action,
      input.reason,
      action === "close" ? hsePermitCloseSchema.parse(input) : undefined,
    );
  });
}
export async function getHsePermit(db: Database, ws: string, id: string) {
  const p = await permitOf(db, ws, id);
  const a = await assetOf(db, ws, p.assetId);
  const c = await recordOf(db, ws, p.body.contractorRecordId);
  const assessments = [];
  for (const ref of p.body.assessmentIds) {
    const r = await recordOf(db, ws, ref);
    assessments.push({ id: r.id, title: r.title });
  }
  return {
    ...hsePublic(p),
    assetName: a.name,
    contractorTitle: c.title,
    assessments,
    /** What signing (issue or resume) would rely on now; signing must name these versions. */
    currentEvidence: await permitEvidenceVersions(db, ws, p.body),
    references: await contentReferences(db, ws, [
      ...((p.evidenceSnapshot as { assessments?: { content: HseContent }[] } | null)?.assessments ?? []).map(
        (a) => a.content,
      ),
      (p.evidenceSnapshot as { contractor?: { content: HseContent } } | null)?.contractor?.content,
    ]),
  };
}
export async function listHsePermits(
  db: Database,
  ws: string,
  q: HsePage & { status?: typeof permits.$inferSelect.status },
) {
  const where = and(eq(permits.workspaceId, ws), q.status ? eq(permits.status, q.status) : undefined);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(permits)
      .where(where)
      .orderBy(desc(permits.createdAt), desc(permits.id))
      .limit(q.limit)
      .offset(q.offset),
    db.select({ n: count() }).from(permits).where(where),
  ]);
  const today = await workspaceToday(db, ws);
  return {
    permits: rows.map((p) => ({
      ...hsePublic(p),
      expired: ["issued", "suspended"].includes(p.status) && p.body.endsOn < today,
    })),
    total: total!.n,
    limit: q.limit,
    offset: q.offset,
  };
}
export async function hsePermitHistory(db: Database, ws: string, id: string, q: HsePage) {
  await permitOf(db, ws, id);
  const where = and(eq(permitEvents.workspaceId, ws), eq(permitEvents.permitId, id));
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(permitEvents)
      .where(where)
      .orderBy(desc(permitEvents.revision))
      .limit(q.limit)
      .offset(q.offset),
    db.select({ n: count() }).from(permitEvents).where(where),
  ]);
  return { events: rows.map(hsePublic), total: total!.n, ...q };
}
