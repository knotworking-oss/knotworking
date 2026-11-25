import {
  hseContentSchema,
  hsePermitBodySchema,
  newId,
  attachmentTargets,
  attachmentTargetTypes,
  moduleIds,
  type AttachmentTargetType,
  type ModuleId,
} from "@knotworking/core";
import {
  hseRecords,
  hseVersions,
  hseEntries,
  hsePermits,
  assets,
  haccpCalibrationRecords,
  haccpCleaningRecords,
  haccpCorrectiveActions,
  items,
  purchaseInvoices,
  purchaseOrderLines,
  purchaseOrders,
  purchaseReceipts,
  qualityAudits,
  qualityComplaints,
  qualityNonconformances,
  qualityRecallTests,
  recordChanges,
  siteGlassBreakages,
  sops,
  npdProjects,
  defenceExercises,
  specifications,
  supplierQuestionnaires,
  testingSamples,
  staff,
  stockLots,
  suppliers,
  trainingCourses,
  trainingRecords,
  workspaceMembers,
  workspaces,
  users,
} from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStorage } from "./storage";
import { APP_URL, makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const base = "/v1/workspaces/acme";
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("\0\0\0\rIHDR fake image data"),
]);
const PDF = Buffer.from("%PDF-1.4 fake certificate");

/** Append-only records: final once recorded, so their files are locked from the start. */
const alwaysLocked = new Set<AttachmentTargetType>([
  "quality_recall_test",
  "haccp_calibration_record",
  "hse_record",
  "hse_entry",
  "hse_permit",
]);

type Auth = { cookie?: string; token?: string };

describe("attachments on module records", () => {
  let ctx: TestCtx;
  let storage: MemoryStorage;
  let ada: string; // owner: manage everywhere
  let marcus: string; // member
  let marcusId: string;
  let writeToken: string; // marcus's
  let readToken: string;
  let records: Record<AttachmentTargetType, string>;
  let workspaceId: string;
  // A second workspace holding a supplier of its own.
  let foreignSupplier: string;

  const headers = ({ cookie, token }: Auth): Record<string, string> => ({
    origin: APP_URL,
    ...(cookie ? { cookie } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  const upload = async (
    auth: Auth,
    fields: Record<string, string>,
    name = "cert.pdf",
    bytes: Buffer = PDF,
    type = "application/pdf",
    slug = "acme",
  ) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("file", new File([new Uint8Array(bytes)], name, { type }));
    return (await ctx.app.request(`/v1/workspaces/${slug}/attachments`, {
      method: "POST",
      body: form,
      headers: headers(auth),
    })) as unknown as Res;
  };
  const on = (type: AttachmentTargetType, extra: Record<string, string> = {}) => ({
    entityType: type,
    entityId: records[type],
    ...extra,
  });
  const list = (cookie: string, type: string, id: string, slug = "acme") =>
    ctx.req(`/v1/workspaces/${slug}/attachments?entityType=${type}&entityId=${id}`, { cookie });
  const level = (moduleId: ModuleId, lvl: string | null) =>
    ctx.req(`${base}/members/${marcusId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level: lvl },
    });
  const code = async (res: Res) => (await res.json()).error.code as string;

  beforeAll(async () => {
    storage = new MemoryStorage();
    ctx = await makeApp({ seed: true, storage, uploadMaxBytes: 64 * 1024 });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const db = ctx.handle.db;
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, "acme"));
    workspaceId = ws!.id;
    const [marcusUser] = await db.select().from(users).where(eq(users.email, "marcus@knotworking.dev"));
    marcusId = marcusUser!.id;
    // Modules are opt-in and need their dependencies readable, so grant the lot.
    for (const id of moduleIds) if (id !== "assistant") await level(id, "write");

    const mint = async (scope: "read" | "write") =>
      (
        await (
          await ctx.req("/v1/me/api-tokens", { method: "POST", cookie: marcus, json: { name: scope, scope } })
        ).json()
      ).token as string;
    writeToken = await mint("write");
    readToken = await mint("read");

    // One record of each target, inserted directly with the fewest columns the tables need.
    const w = workspaceId;
    const one = async <T>(q: Promise<{ id: string }[]> & T) => (await q)[0]!.id;
    const [supplier, item, area, course, member] = [
      await one(db.insert(suppliers).values({ workspaceId: w, name: "Mill Co" }).returning()),
      await one(
        db
          .insert(items)
          .values({ workspaceId: w, code: "FLOUR", name: "Flour", type: "ingredient", unit: "g" })
          .returning(),
      ),
      await one(db.insert(assets).values({ workspaceId: w, kind: "area", name: "Bake hall" }).returning()),
      await one(
        db
          .insert(trainingCourses)
          .values({ workspaceId: w, code: "HYG", title: "Hygiene", kind: "induction" })
          .returning(),
      ),
      await one(
        db
          .insert(staff)
          .values({ workspaceId: w, staffNumber: "S1", firstName: "Gus", lastName: "Test" })
          .returning(),
      ),
    ];
    const [secondWs] = await db.insert(workspaces).values({ slug: "globex", name: "Globex" }).returning();
    foreignSupplier = await one(
      db.insert(suppliers).values({ workspaceId: secondWs!.id, name: "Elsewhere Ltd" }).returning(),
    );
    await db.insert(workspaceMembers).values({ workspaceId: secondWs!.id, userId: marcusId, role: "owner" });

    const order = await one(
      db
        .insert(purchaseOrders)
        .values({ workspaceId: w, reference: "PO-1", supplierId: supplier })
        .returning(),
    );
    const orderLine = await one(
      db
        .insert(purchaseOrderLines)
        .values({ workspaceId: w, purchaseOrderId: order, lineNo: 1, itemId: item, quantity: 5, unit: "g" })
        .returning(),
    );
    const lot = await one(
      db
        .insert(stockLots)
        .values({ workspaceId: w, itemId: item, lotCode: "L1", receivedOn: "2026-01-01" })
        .returning(),
    );

    const receipt = await one(
      db
        .insert(purchaseReceipts)
        .values({
          workspaceId: w,
          purchaseOrderId: order,
          lineId: orderLine,
          itemId: item,
          deliveryId: crypto.randomUUID(),
          outcome: "rejected",
          quantity: 5,
          receivedOn: "2026-01-03",
        })
        .returning(),
    );

    const hseRecord = await one(
      db
        .insert(hseRecords)
        .values({ workspaceId: w, title: "HSE evidence", kind: "risk_assessment" })
        .returning(),
    );
    const hseVersion = await one(
      db
        .insert(hseVersions)
        .values({
          workspaceId: w,
          recordId: hseRecord,
          number: 1,
          content: hseContentSchema.parse({}),
          reason: "Fixture",
        })
        .returning(),
    );
    const hseEntry = await one(
      db
        .insert(hseEntries)
        .values({
          workspaceId: w,
          recordId: hseRecord,
          versionId: hseVersion,
          performedOn: "2026-01-01",
          outcome: "pass",
          findings: "Fixture",
          actions: "",
          evidenceReference: "Certificate",
        })
        .returning(),
    );
    const hseAsset = await one(
      db.insert(assets).values({ workspaceId: w, kind: "equipment", name: "Fixture asset" }).returning(),
    );
    const hsePermit = await one(
      db
        .insert(hsePermits)
        .values({
          workspaceId: w,
          title: "Fixture permit",
          assetId: hseAsset,
          isolationRequired: false,
          body: hsePermitBodySchema.parse({
            contractorRecordId: newId(),
            assessmentIds: [hseRecord],
            assetId: hseAsset,
            startsOn: "2026-01-01",
            endsOn: "2026-01-02",
            workScope: "Fixture",
            precautions: "Safe work",
            isolationRequired: false,
            inductionChecked: false,
            ppeChecked: false,
            emergencyReady: false,
          }),
        })
        .returning(),
    );
    records = {
      hse_record: hseRecord,
      hse_entry: hseEntry,
      hse_permit: hsePermit,
      training_record: await one(
        db
          .insert(trainingRecords)
          .values({
            workspaceId: w,
            staffId: member,
            courseId: course,
            completedOn: "2026-01-01",
            outcome: "competent",
          })
          .returning(),
      ),
      supplier,
      item,
      sop: await one(db.insert(sops).values({ workspaceId: w, code: "SOP-T", title: "Test" }).returning()),
      specification: await one(
        db
          .insert(specifications)
          .values({ workspaceId: w, code: "SPEC-T", title: "Test", itemId: item })
          .returning(),
      ),
      supplier_questionnaire: await one(
        db
          .insert(supplierQuestionnaires)
          .values({ workspaceId: w, supplierId: supplier, title: "SAQ", sentOn: "2026-01-02" })
          .returning(),
      ),
      npd_project: await one(
        db.insert(npdProjects).values({ workspaceId: w, code: "NPD-T", name: "Test" }).returning(),
      ),
      defence_exercise: await one(
        db
          .insert(defenceExercises)
          .values({
            workspaceId: w,
            title: "Drill",
            scenario: "x",
            heldOn: "2026-01-02",
            outcome: "effective",
          })
          .returning(),
      ),
      testing_sample: await one(
        db
          .insert(testingSamples)
          .values({
            workspaceId: w,
            reference: "S-T",
            subject: "lot",
            lotId: lot,
            itemId: item,
            sampledOn: "2026-01-02",
          })
          .returning(),
      ),
      quality_complaint: await one(
        db
          .insert(qualityComplaints)
          .values({
            workspaceId: w,
            reference: "C-1",
            receivedOn: "2026-01-01",
            source: "consumer",
            category: "foreign_body",
            severity: "major",
            description: "Plastic in a loaf",
          })
          .returning(),
      ),
      quality_nonconformance: await one(
        db
          .insert(qualityNonconformances)
          .values({
            workspaceId: w,
            reference: "NC-1",
            raisedOn: "2026-01-01",
            source: "process",
            severity: "minor",
            title: "Scale drift",
            description: "Scale out by 5 g",
          })
          .returning(),
      ),
      site_glass_breakage: await one(
        db
          .insert(siteGlassBreakages)
          .values({
            workspaceId: w,
            areaId: area,
            occurredAt: new Date(),
            description: "Light cover broke",
            quarantined: "Tray 4",
          })
          .returning(),
      ),
      haccp_corrective_action: await one(
        db.insert(haccpCorrectiveActions).values({ workspaceId: w, title: "Re-cook batch" }).returning(),
      ),
      purchase_order: order,
      quality_audit: await one(
        db
          .insert(qualityAudits)
          .values({ workspaceId: w, reference: "AUD-1", title: "BRCGS internal", plannedOn: "2026-02-01" })
          .returning(),
      ),
      quality_recall_test: await one(
        db
          .insert(qualityRecallTests)
          .values({
            workspaceId: w,
            reference: "MR-1",
            conductedOn: "2026-01-02",
            lotId: lot,
            direction: "both",
            startedAt: new Date("2026-01-02T09:00:00Z"),
            completedAt: new Date("2026-01-02T10:00:00Z"),
            durationMinutes: 60,
            quantityExpected: 100,
            quantityTraced: 100,
            unit: "g",
            passed: true,
          })
          .returning(),
      ),
      purchase_receipt: receipt,
      // The same row, filed as one line of the delivery.
      purchase_receipt_line: receipt,
      haccp_calibration_record: await one(
        db
          .insert(haccpCalibrationRecords)
          .values({
            workspaceId: w,
            assetId: area,
            calibratedAt: new Date("2026-01-04T08:00:00Z"),
            referenceReading: 0,
            actualReading: 0.2,
            passed: true,
          })
          .returning(),
      ),
      haccp_cleaning_record: await one(
        db
          .insert(haccpCleaningRecords)
          .values({ workspaceId: w, assetId: area, cleanedAt: new Date("2026-01-04T07:00:00Z") })
          .returning(),
      ),
      purchase_invoice: await one(
        db
          .insert(purchaseInvoices)
          .values({ workspaceId: w, supplierId: supplier, invoiceNumber: "INV-1", invoiceDate: "2026-01-01" })
          .returning(),
      ),
    };
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("covers every registry entry with a module of its own and a default kind", () => {
    for (const type of attachmentTargetTypes) {
      expect(attachmentTargets[type].kinds.length, type).toBeGreaterThan(0);
      expect(records[type], type).toBeTruthy();
    }
  });

  it.each(attachmentTargetTypes)("attaches to, lists and serves a file on a %s", async (type) => {
    const kind = attachmentTargets[type].kinds[0];
    const res = await upload({ cookie: marcus }, on(type));
    expect(res.status).toBe(201);
    const a = await res.json();
    expect(a).toMatchObject({
      entityType: type,
      entityId: records[type],
      kind,
      taskId: null,
      documentId: null,
      filename: "cert.pdf",
    });
    const listed = await (await list(marcus, type, records[type])).json();
    expect(listed.attachments.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect(listed.locked).toBe(alwaysLocked.has(type));
    const served = await ctx.req(`${base}/attachments/${a.id}/content`, { cookie: marcus });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("only accepts the kinds a target allows, and a record that exists", async () => {
    expect((await upload({ cookie: marcus }, on("item", { kind: "photo" }))).status).toBe(400);
    expect((await upload({ cookie: marcus }, on("quality_complaint", { kind: "reply_letter" }))).status).toBe(
      201,
    );
    expect((await upload({ cookie: marcus }, { entityType: "supplier" })).status).toBe(400);
    expect((await upload({ cookie: marcus }, { entityType: "nope", entityId: records.item })).status).toBe(
      400,
    );
    const missing = await upload({ cookie: marcus }, { entityType: "item", entityId: records.supplier });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.message).toMatch(/Unknown entityId/);
    // Not both a task and a record.
    expect((await upload({ cookie: marcus }, on("item", { taskId: records.item }))).status).toBe(400);
    // A refused upload leaves no bytes behind.
    const before = storage.objects.size;
    await upload({ cookie: marcus }, on("item", { kind: "photo" }));
    expect(storage.objects.size).toBe(before);
  });

  it("follows the record's module: read to see, write to attach, uploader or manage to delete", async () => {
    const mine = await (await upload({ cookie: marcus }, on("supplier", { kind: "certificate" }))).json();
    const adas = await (await upload({ cookie: ada }, on("supplier", { kind: "specification" }))).json();

    // Read: can see and download, cannot attach or delete.
    await level("items", "read");
    expect((await list(marcus, "supplier", records.supplier)).status).toBe(200);
    expect((await ctx.req(`${base}/attachments/${mine.id}/content`, { cookie: marcus })).status).toBe(200);
    const noWrite = await upload({ cookie: marcus }, on("supplier"));
    expect(noWrite.status).toBe(403);
    expect(await code(noWrite)).toBe("module_forbidden");
    expect(
      (await ctx.req(`${base}/attachments/${mine.id}`, { method: "DELETE", cookie: marcus })).status,
    ).toBe(403);

    // Write: attaches, deletes their own file but not someone else's.
    await level("items", "write");
    expect((await upload({ cookie: marcus }, on("supplier"))).status).toBe(201);
    const others = await ctx.req(`${base}/attachments/${adas.id}`, { method: "DELETE", cookie: marcus });
    expect(others.status).toBe(403);
    expect(await code(others)).toBe("forbidden");

    // Manage: deletes anyone's.
    await level("items", "manage");
    expect(
      (await ctx.req(`${base}/attachments/${adas.id}`, { method: "DELETE", cookie: marcus })).status,
    ).toBe(204);

    // None: nothing about the record or its files is visible, in the API or the sync log.
    const { cursor } = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();
    await upload({ cookie: ada }, on("item"));
    await level("items", "none");
    for (const res of [
      await list(marcus, "supplier", records.supplier),
      await ctx.req(`${base}/attachments/${mine.id}`, { cookie: marcus }),
      await ctx.req(`${base}/attachments/${mine.id}/content`, { cookie: marcus }),
      await upload({ cookie: marcus }, on("supplier")),
      await ctx.req(`${base}/attachments/${mine.id}`, { method: "DELETE", cookie: marcus }),
    ]) {
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("module_forbidden");
    }
    const sync = (cookie: string) =>
      ctx.req(`${base}/sync?after=${cursor}`, { cookie }).then((r) => r.json()) as Promise<{
        changes: { entity: string; action: string; data?: { entityType?: string } }[];
      }>;
    const seenByAda = (await sync(ada)).changes.filter(
      (c) => c.entity === "attachment" && c.action === "upsert",
    );
    expect(seenByAda.some((c) => c.data?.entityType === "item")).toBe(true);
    const seenByMarcus = (await sync(marcus)).changes.filter(
      (c) => c.entity === "attachment" && c.action === "upsert",
    );
    expect(seenByMarcus.some((c) => c.data?.entityType === "item")).toBe(false);
    await level("items", "write");
  });

  it("switches off with the module", async () => {
    const off = await makeApp({ seed: true, activeModules: ["tasks", "docs", "time", "calendar"] });
    try {
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const res = await off.req(`${base}/attachments?entityType=item&entityId=${records.item}`, { cookie });
      expect(res.status).toBe(404);
      expect(await code(res)).toBe("module_inactive");
    } finally {
      await off.handle.close();
    }
  }, 60_000);

  it("keeps contractor permit evidence behind Assets access when HSE registers are visible", async () => {
    const { cursor } = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();
    const uploaded = await upload({ cookie: ada }, on("hse_permit"));
    expect(uploaded.status).toBe(201);
    const { id } = await uploaded.json();
    const link = await (await ctx.req(`${base}/attachments/${id}/link`, { cookie: marcus })).json();
    const publicPath = new URL(link.url).pathname.replace(/^\/api/, "");
    await level("assets", "none");
    try {
      expect((await ctx.req(`${base}/hse/registers`, { cookie: marcus })).status).toBe(200);
      expect((await list(marcus, "hse_permit", records.hse_permit)).status).toBe(403);
      expect((await ctx.req(`${base}/attachments/${id}/content`, { cookie: marcus })).status).toBe(403);
      expect((await ctx.req(publicPath)).status).toBe(404);
      const sync = await (await ctx.req(`${base}/sync?after=${cursor}`, { cookie: marcus })).json();
      expect(sync.changes.some((change: { entityId: string }) => change.entityId === id)).toBe(false);
    } finally {
      await level("assets", "write");
    }
  });

  it("shares Quality sync records and recall files only with their linked module access", async () => {
    const { cursor } = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();
    const uploaded = await upload({ cookie: ada }, on("quality_recall_test"));
    expect(uploaded.status).toBe(201);
    const attachment = await uploaded.json();
    const recallId = records.quality_recall_test;
    const volumeId = newId();
    const authenticityId = newId();
    await ctx.handle.db.transaction((tx) =>
      recordChanges(tx, workspaceId, null, [
        { entity: "quality_recall_test", entityId: recallId, action: "upsert", data: { id: recallId } },
        { entity: "quality_sales_volume", entityId: volumeId, action: "upsert", data: { id: volumeId } },
        {
          entity: "quality_authenticity",
          entityId: authenticityId,
          action: "upsert",
          data: { id: authenticityId },
        },
      ]),
    );
    const seen = async () => {
      const sync = await (await ctx.req(`${base}/sync?after=${cursor}`, { cookie: marcus })).json();
      return sync.changes.map((change: { entityId: string }) => change.entityId) as string[];
    };
    expect(await seen()).toEqual(expect.arrayContaining([recallId, volumeId, authenticityId, attachment.id]));
    await level("stock", "none");
    try {
      expect((await ctx.req(`${base}/quality/audits`, { cookie: marcus })).status).toBe(200);
      expect((await list(marcus, "quality_recall_test", recallId)).status).toBe(403);
      expect((await ctx.req(`${base}/attachments/${attachment.id}/content`, { cookie: marcus })).status).toBe(
        403,
      );
      expect(await seen()).toEqual(expect.arrayContaining([volumeId, authenticityId]));
      expect(await seen()).not.toContain(recallId);
      expect(await seen()).not.toContain(attachment.id);
      await level("items", "none");
      expect(await seen()).not.toContain(volumeId);
      expect(await seen()).not.toContain(authenticityId);
    } finally {
      await level("items", "write");
      await level("stock", "write");
    }
  });

  it("never reaches a record in another workspace", async () => {
    // Marcus belongs to globex too, but the supplier is not in acme.
    const res = await upload({ cookie: marcus }, { entityType: "supplier", entityId: foreignSupplier });
    expect(res.status).toBe(400);
    expect((await list(marcus, "supplier", foreignSupplier)).status).toBe(404);
    // And a file on a globex record is not served through acme or to a non-member.
    const g = await upload(
      { cookie: marcus },
      { entityType: "supplier", entityId: foreignSupplier },
      "g.pdf",
      PDF,
      "application/pdf",
      "globex",
    );
    expect(g.status).toBe(201);
    const file = await g.json();
    expect((await ctx.req(`${base}/attachments/${file.id}/content`, { cookie: marcus })).status).toBe(404);
    expect(
      (await ctx.req(`/v1/workspaces/globex/attachments/${file.id}/content`, { cookie: ada })).status,
    ).toBe(404);
    expect((await list(ada, "supplier", foreignSupplier, "globex")).status).toBe(404);
  });

  it("lets API tokens upload where the module allows writes", async () => {
    expect((await upload({ token: writeToken }, on("training_record"))).status).toBe(201);
    const denied = await upload({ token: readToken }, on("training_record"));
    expect(denied.status).toBe(403);
    expect(await code(denied)).toBe("token_read_only");
    expect((await list(marcus, "training_record", records.training_record)).status).toBe(200);
    expect(
      (
        await ctx.req(`${base}/attachments?entityType=training_record&entityId=${records.training_record}`, {
          headers: { authorization: `Bearer ${readToken}`, origin: "" },
        })
      ).status,
    ).toBe(200);
    // The owner's module access caps the token.
    await level("training", "read");
    const capped = await upload({ token: writeToken }, on("training_record"));
    expect(capped.status).toBe(403);
    expect(await code(capped)).toBe("module_forbidden");
    await level("training", "write");
  });

  describe("signed-off records", () => {
    const lock: Record<string, () => Promise<unknown>> = {};
    const db = () => ctx.handle.db;
    const set = <T extends { id: unknown }>(table: T, id: string, values: object) =>
      db()
        .update(table as never)
        .set(values as never)
        .where(eq((table as unknown as { id: never }).id, id as never));
    Object.assign(lock, {
      training_record: () => set(trainingRecords, records.training_record, { signedOffAt: new Date() }),
      supplier: () => set(suppliers, records.supplier, { approvalStatus: "approved" }),
      quality_complaint: () => set(qualityComplaints, records.quality_complaint, { status: "closed" }),
      quality_nonconformance: () =>
        set(qualityNonconformances, records.quality_nonconformance, { status: "closed" }),
      site_glass_breakage: () => set(siteGlassBreakages, records.site_glass_breakage, { status: "released" }),
      haccp_corrective_action: () =>
        set(haccpCorrectiveActions, records.haccp_corrective_action, { status: "closed" }),
      purchase_order: () => set(purchaseOrders, records.purchase_order, { status: "cancelled" }),
      purchase_invoice: () => set(purchaseInvoices, records.purchase_invoice, { status: "approved" }),
      quality_audit: () => set(qualityAudits, records.quality_audit, { status: "completed" }),
      quality_recall_test: async () => {},
      haccp_calibration_record: async () => {},
      haccp_cleaning_record: () =>
        set(haccpCleaningRecords, records.haccp_cleaning_record, { verifiedAt: new Date() }),
    });

    it.each(Object.keys(lock))("keeps files on a locked %s but still accepts more", async (type) => {
      const t = type as AttachmentTargetType;
      const before = await (await upload({ cookie: marcus }, on(t))).json();
      await lock[type]!();
      const listed = await (await list(marcus, t, records[t])).json();
      expect(listed.locked).toBe(true);
      // Even the uploader, and even a manager, cannot delete it.
      for (const cookie of [marcus, ada]) {
        const del = await ctx.req(`${base}/attachments/${before.id}`, { method: "DELETE", cookie });
        expect(del.status, `${type} ${cookie === ada}`).toBe(409);
        expect(await code(del)).toBe("attachment_locked");
      }
      expect((await ctx.req(`${base}/attachments/${before.id}/content`, { cookie: marcus })).status).toBe(
        200,
      );
      // Evidence can still be added.
      expect((await upload({ cookie: marcus }, on(t))).status).toBe(201);
    });

    it("never locks an item", async () => {
      const a = await (await upload({ cookie: marcus }, on("item"))).json();
      expect(
        (await ctx.req(`${base}/attachments/${a.id}`, { method: "DELETE", cookie: marcus })).status,
      ).toBe(204);
    });
  });

  it("hides files of a deleted record", async () => {
    const [row] = await ctx.handle.db
      .insert(suppliers)
      .values({ workspaceId, name: "Gone Ltd", deletedAt: new Date() })
      .returning();
    expect((await upload({ cookie: marcus }, { entityType: "supplier", entityId: row!.id })).status).toBe(
      400,
    );
    expect((await list(marcus, "supplier", row!.id)).status).toBe(404);
  });

  it("leaves task and document attachments working", async () => {
    const boot = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();
    const taskId = boot.tasks[0].id;
    const docId = boot.documents[0].id;
    const t = await upload({ cookie: marcus }, { taskId }, "t.png", PNG, "image/png");
    expect(t.status).toBe(201);
    const task = await t.json();
    expect(task).toMatchObject({ taskId, entityType: null, entityId: null, kind: null });
    const d = await upload({ cookie: marcus }, { documentId: docId }, "d.png", PNG, "image/png");
    expect(d.status).toBe(201);
    const listed = await (await ctx.req(`${base}/tasks/${taskId}/attachments`, { cookie: ada })).json();
    expect(listed.attachments.map((x: { id: string }) => x.id)).toContain(task.id);
    // Deleting is still the uploader or an admin, and not blocked by any record lock.
    expect(
      (await ctx.req(`${base}/attachments/${task.id}`, { method: "DELETE", cookie: marcus })).status,
    ).toBe(204);
    // A task file can't also hang on a record, and a task needs the tasks module.
    expect((await upload({ cookie: marcus }, on("item", { taskId }))).status).toBe(400);
    await level("tasks", "none");
    expect((await upload({ cookie: marcus }, { taskId })).status).toBe(403);
    await level("tasks", "write");
  });
});
