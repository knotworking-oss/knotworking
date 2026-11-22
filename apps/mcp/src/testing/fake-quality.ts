import {
  addDaysIso,
  auditState,
  complaintOpensNonconformance,
  complaintCategoryLabels,
  isNonconformanceOverdue,
  newId,
  nonconformanceDueDays,
  qualityReference,
} from "@knotworking/core";
import type { Hono } from "hono";
import type { mountFakeItems } from "./fake-items";
import type { mountFakeStock } from "./fake-stock";

/** In-memory stand-in for the Quality module's routes (apps/server/src/routes/quality.ts). */
export function mountFakeQuality(
  app: Hono,
  ws: string,
  deps: { items: ReturnType<typeof mountFakeItems>; stock: ReturnType<typeof mountFakeStock> },
) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const now = "2026-01-05T09:00:00.000Z";
  const today = "2026-01-05";
  const complaints: Record<string, any>[] = [];
  const nonconformances: Record<string, any>[] = [];
  const audits: Record<string, any>[] = [];
  const recallTests: Record<string, any>[] = [];
  const nextRef = (prefix: string, list: Record<string, any>[], date: string) =>
    qualityReference(
      prefix,
      date,
      list.filter((x) => x.reference.startsWith(`${prefix}-${date.slice(0, 4)}`)).length + 1,
    );
  const itemRef = (id: string | null) => {
    const item = id ? deps.items.items.find((i) => i.id === id) : null;
    return item ? { id: item.id, code: item.code, name: item.name, unit: item.unit } : null;
  };
  const lotRef = (id: string | null) => {
    const lot = id ? deps.stock.lots.find((l) => l.id === id) : null;
    return lot
      ? { id: lot.id, lotCode: lot.lotCode, itemId: lot.itemId, expiresOn: null, item: itemRef(lot.itemId) }
      : null;
  };
  const ncSummary = (n: Record<string, any>) => ({
    id: n.id,
    reference: n.reference,
    title: n.title,
    severity: n.severity,
    status: n.status,
    dueOn: n.dueOn,
    overdue: isNonconformanceOverdue(n as any, today),
  });
  const complaintView = (c: Record<string, any>) => ({
    ...c,
    item: itemRef(c.itemId),
    lot: lotRef(c.lotId),
    createdByName: "Ada Lovelace",
    closedByName: null,
    nonconformanceCount: nonconformances.filter((n) => n.complaintId === c.id).length,
    nonconformances: nonconformances.filter((n) => n.complaintId === c.id).map(ncSummary),
  });
  const ncView = (n: Record<string, any>) => {
    const complaint = complaints.find((c) => c.id === n.complaintId);
    return {
      ...n,
      overdue: isNonconformanceOverdue(n as any, today),
      complaint: complaint
        ? { id: complaint.id, reference: complaint.reference, status: complaint.status }
        : null,
      audit: null,
      item: itemRef(n.itemId),
      lot: lotRef(n.lotId),
      supplier: null,
      owner: null,
      createdByName: "Ada Lovelace",
      closedByName: null,
    };
  };
  const auditView = (a: Record<string, any>) => ({
    ...a,
    state: auditState(a as any, today),
    auditor: null,
    completedByName: null,
    cancelledByName: null,
    findings: { total: 0, open: 0 },
    nonconformances: [],
  });
  const insertNc = (fields: Record<string, any>) => {
    const severity = fields.severity ?? "minor";
    const nc = {
      id: newId(),
      reference: nextRef("NC", nonconformances, fields.raisedOn),
      status: "open",
      severity,
      complaintId: null,
      auditId: null,
      itemId: null,
      lotId: null,
      supplierId: null,
      containment: null,
      rootCause: null,
      correctiveAction: null,
      preventiveAction: null,
      ownerUserId: null,
      actionTakenAt: null,
      closedAt: null,
      closedBy: null,
      verificationNote: null,
      createdAt: now,
      updatedAt: now,
      ...fields,
      dueOn: fields.dueOn ?? addDaysIso(fields.raisedOn, nonconformanceDueDays[severity as "minor"]),
    };
    nonconformances.push(nc);
    return nc;
  };
  const matches = (text: string | undefined, ...fields: (string | null)[]) =>
    !text || fields.some((f) => f?.toLowerCase().includes(text.toLowerCase()));

  app.get(`${ws}/quality/summary`, (c) =>
    c.json({
      today,
      complaints: {
        open: complaints.filter((x) => x.status === "open").length,
        investigating: complaints.filter((x) => x.status === "investigating").length,
        receivedLast30Days: complaints.length,
        byCategoryLast12Months: [],
      },
      nonconformances: {
        open: nonconformances.filter((x) => x.status === "open").length,
        awaitingVerification: nonconformances.filter((x) => x.status === "action_taken").length,
        overdue: nonconformances.filter((x) => isNonconformanceOverdue(x as any, today)).length,
      },
      audits: { overdue: 0, soon: 0, completedLast12Months: 0, next: null },
      recallTest: { last: null, lastPassed: null, dueOn: null, state: "never" },
    }),
  );

  app.get(`${ws}/quality/complaints`, (c) => {
    const status = c.req.query("status") ?? "all";
    const found = complaints.filter(
      (x) =>
        (status === "all" || (status === "unresolved" ? x.status !== "closed" : x.status === status)) &&
        matches(c.req.query("q"), x.reference, x.description) &&
        (!c.req.query("itemId") || x.itemId === c.req.query("itemId")),
    );
    return c.json({ complaints: found.map(complaintView), total: found.length, limit: 100, offset: 0 });
  });
  app.get(`${ws}/quality/complaints/:id`, (c) => {
    const found = complaints.find((x) => x.id === c.req.param("id"));
    return found ? c.json(complaintView(found)) : c.json(err("not_found", "Complaint not found"), 404);
  });
  app.post(`${ws}/quality/complaints`, async (c) => {
    const body = await c.req.json();
    const complaint = {
      id: newId(),
      reference: nextRef("CMP", complaints, body.receivedOn),
      status: "open",
      severity: "minor",
      complainantName: null,
      complainantContact: null,
      customer: null,
      itemId: null,
      lotId: null,
      reportedLotCode: null,
      investigation: null,
      rootCause: null,
      response: null,
      justified: null,
      closedAt: null,
      closedBy: null,
      closeNote: null,
      createdAt: now,
      updatedAt: now,
      ...body,
    };
    complaints.push(complaint);
    if (complaintOpensNonconformance(complaint)) {
      insertNc({
        raisedOn: today,
        source: "complaint",
        severity: complaint.severity,
        title: `${complaintCategoryLabels[complaint.category as "other"]} complaint ${complaint.reference}`,
        description: complaint.description,
        complaintId: complaint.id,
        itemId: complaint.itemId,
        lotId: complaint.lotId,
      });
    }
    return c.json(complaintView(complaint), 201);
  });
  app.patch(`${ws}/quality/complaints/:id`, async (c) => {
    const found = complaints.find((x) => x.id === c.req.param("id"));
    if (!found) return c.json(err("not_found", "Complaint not found"), 404);
    if (found.status === "closed") return c.json(err("complaint_closed", "This complaint is closed"), 409);
    Object.assign(found, await c.req.json());
    return c.json(complaintView(found));
  });

  app.get(`${ws}/quality/nonconformances`, (c) => {
    const status = c.req.query("status") ?? "all";
    const found = nonconformances.filter(
      (x) =>
        (status === "all" ||
          (status === "unresolved"
            ? x.status !== "closed"
            : status === "overdue"
              ? isNonconformanceOverdue(x as any, today)
              : x.status === status)) &&
        matches(c.req.query("q"), x.reference, x.title, x.description),
    );
    return c.json({ nonconformances: found.map(ncView), total: found.length, limit: 100, offset: 0 });
  });
  app.get(`${ws}/quality/nonconformances/:id`, (c) => {
    const found = nonconformances.find((x) => x.id === c.req.param("id"));
    return found ? c.json(ncView(found)) : c.json(err("not_found", "Non-conformance not found"), 404);
  });
  app.post(`${ws}/quality/nonconformances`, async (c) => c.json(ncView(insertNc(await c.req.json())), 201));
  app.patch(`${ws}/quality/nonconformances/:id`, async (c) => {
    const found = nonconformances.find((x) => x.id === c.req.param("id"));
    if (!found) return c.json(err("not_found", "Non-conformance not found"), 404);
    const patch = await c.req.json();
    const action = patch.correctiveAction ?? found.correctiveAction;
    if ((patch.status ?? found.status) === "action_taken" && !action)
      return c.json(err("invalid_input", "Record the corrective action before marking it taken"), 400);
    Object.assign(found, patch);
    return c.json(ncView(found));
  });

  app.get(`${ws}/quality/audits`, (c) => {
    const found = audits.filter((x) => matches(c.req.query("q"), x.reference, x.title));
    return c.json({ audits: found.map(auditView), total: found.length, limit: 100, offset: 0 });
  });
  app.get(`${ws}/quality/audits/:id`, (c) => {
    const found = audits.find((x) => x.id === c.req.param("id"));
    return found ? c.json(auditView(found)) : c.json(err("not_found", "Audit not found"), 404);
  });
  app.post(`${ws}/quality/audits`, async (c) => {
    const body = await c.req.json();
    const audit = {
      id: newId(),
      reference: nextRef("IA", audits, body.plannedOn),
      scope: null,
      auditorUserId: null,
      auditorName: null,
      status: "planned",
      completedOn: null,
      summary: null,
      cancelReason: null,
      createdAt: now,
      updatedAt: now,
      ...body,
    };
    audits.push(audit);
    return c.json(auditView(audit), 201);
  });

  app.get(`${ws}/quality/recall-tests`, (c) => {
    const found = recallTests.filter((x) => matches(c.req.query("q"), x.reference));
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json({
      recallTests: found.slice(0, limit).map((r) => ({ ...r, lot: lotRef(r.lotId) })),
      total: found.length,
      limit,
      offset: 0,
    });
  });
  app.get(`${ws}/quality/recall-tests/:id`, (c) => {
    const found = recallTests.find((x) => x.id === c.req.param("id"));
    return found
      ? c.json({ ...found, lot: lotRef(found.lotId), recordedByName: "Ada Lovelace", voidedByName: null })
      : c.json(err("not_found", "Recall test not found"), 404);
  });

  return { complaints, nonconformances, audits, recallTests };
}
