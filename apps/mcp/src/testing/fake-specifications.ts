import {
  diffSpecifications,
  itemDiscrepancies,
  newId,
  specificationApprovalBlockers,
  specificationCreateSchema,
  specificationDraftSchema,
  specificationKindOf,
  specificationPartyOf,
  specificationReviewState,
  type SpecificationContent,
} from "@knotworking/core";
import type { Hono } from "hono";

/**
 * In-memory stand-in for the Specifications module's routes
 * (apps/server/src/routes/specifications.ts). The impact report lists recipes that make or use
 * the item directly; the real one follows work-in-progress recipes further.
 */
export function mountFakeSpecifications(
  app: Hono,
  ws: string,
  deps: { items: Record<string, any>[]; suppliers: Record<string, any>[]; recipes: Record<string, any>[] },
) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const now = "2026-01-05T09:00:00.000Z";
  const today = "2026-01-05";
  const byCode = (code: string) => deps.items.find((i) => i.code === code)!;

  type Version = Record<string, any> & {
    id: string;
    versionNumber: number;
    status: string;
    parameters: any[];
  };
  interface Spec {
    id: string;
    code: string;
    title: string;
    itemId: string;
    supplierId: string | null;
    customerName: string | null;
    status: "active" | "archived";
    versions: Version[];
  }

  const version = (n: number, status: string, fields: Record<string, unknown>): Version => ({
    id: newId(),
    versionNumber: n,
    status,
    description: null,
    storage: null,
    storageInstructions: null,
    shelfLifeDays: null,
    minimumLifeOnReceiptDays: null,
    allergens: [],
    mayContain: [],
    countryOfOrigin: null,
    provenance: null,
    claims: [],
    packagingDetails: null,
    parameters: [],
    reviewDueOn: null,
    agreedBy: null,
    agreedOn: null,
    agreementReference: null,
    changeNote: null,
    approvedAt: status === "draft" ? null : now,
    approvedByName: status === "draft" ? null : "Ada Lovelace",
    lastEditedByName: "Ada Lovelace",
    createdAt: now,
    updatedAt: now,
    ...fields,
  });

  const specs: Spec[] = [
    {
      id: newId(),
      code: "SPEC-FLR-SHIP",
      title: "Strong white flour (Shipton Mill)",
      itemId: byCode("FLR-001").id,
      supplierId: deps.suppliers[0]!.id,
      customerName: null,
      status: "active",
      versions: [
        version(1, "approved", {
          storage: "ambient",
          shelfLifeDays: 270,
          allergens: ["cereals_gluten"],
          mayContain: ["sesame"],
          reviewDueOn: "2026-01-20",
          agreedBy: "R. Shipton",
          agreedOn: "2025-12-01",
          parameters: [
            {
              id: newId(),
              category: "chemical",
              name: "Moisture",
              unit: "%",
              min: null,
              target: null,
              max: 15.5,
              limitText: null,
              method: null,
              note: null,
            },
          ],
        }),
      ],
    },
  ];

  const contentOf = (v: Version): SpecificationContent => ({
    description: v.description,
    storage: v.storage,
    storageInstructions: v.storageInstructions,
    shelfLifeDays: v.shelfLifeDays,
    minimumLifeOnReceiptDays: v.minimumLifeOnReceiptDays,
    allergens: v.allergens,
    mayContain: v.mayContain,
    countryOfOrigin: v.countryOfOrigin,
    provenance: v.provenance,
    claims: v.claims,
    packagingDetails: v.packagingDetails,
    parameters: v.parameters,
  });

  const detail = (s: Spec) => {
    const item = deps.items.find((i) => i.id === s.itemId)!;
    const supplier = deps.suppliers.find((x) => x.id === s.supplierId) ?? null;
    const approved = s.versions.find((v) => v.status === "approved") ?? null;
    const draft = s.versions.find((v) => v.status === "draft") ?? null;
    const kind = specificationKindOf(item.type);
    const party = specificationPartyOf(s);
    const facts = {
      allergens: item.allergens,
      mayContain: item.mayContain,
      storage: item.storage,
      shelfLifeDays: item.shelfLifeDays,
    };
    return {
      id: s.id,
      code: s.code,
      title: s.title,
      itemId: s.itemId,
      supplierId: s.supplierId,
      customerName: s.customerName,
      status: s.status,
      kind,
      party,
      item: { id: item.id, code: item.code, name: item.name, type: item.type },
      supplier: supplier ? { id: supplier.id, name: supplier.name, code: supplier.code } : null,
      versions: [...s.versions].reverse().map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        status: v.status,
        changeNote: v.changeNote,
        approvedAt: v.approvedAt,
        approvedByName: v.approvedByName,
      })),
      approvedVersion: approved,
      draftVersion: draft,
      draftChanges: draft
        ? diffSpecifications(approved ? contentOf(approved) : null, contentOf(draft))
        : null,
      draftBlockers: draft
        ? specificationApprovalBlockers({
            kind,
            party,
            content: contentOf(draft),
            reviewDueOn: draft.reviewDueOn,
            agreedOn: draft.agreedOn,
            today,
          })
        : [],
      discrepancies: approved ? itemDiscrepancies(contentOf(approved), facts) : [],
      draftDiscrepancies: draft ? itemDiscrepancies(contentOf(draft), facts) : [],
      reviewState: specificationReviewState(approved?.reviewDueOn ?? null, today),
      today,
    };
  };

  const find = (id: string) => specs.find((s) => s.id === id);

  app.get(`${ws}/specifications`, (c) => {
    const q = c.req.query("q")?.toLowerCase();
    const status = c.req.query("status") ?? "active";
    const itemId = c.req.query("itemId");
    const supplierId = c.req.query("supplierId");
    const kind = c.req.query("kind");
    const review = c.req.query("review");
    const rows = specs
      .map(detail)
      .filter((s) => status === "all" || s.status === status)
      .filter(
        (s) => !q || [s.code, s.title, s.item.code, s.item.name].some((t) => t.toLowerCase().includes(q)),
      )
      .filter((s) => !itemId || s.itemId === itemId)
      .filter((s) => !supplierId || s.supplierId === supplierId)
      .filter((s) => !kind || s.kind === kind)
      .filter(
        (s) =>
          !review ||
          (review === "overdue"
            ? s.reviewState === "overdue"
            : review === "due_soon"
              ? s.reviewState === "due_soon"
              : s.reviewState !== "ok"),
      );
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    return c.json({
      specifications: rows.slice(offset, offset + limit).map((s) => ({
        ...s,
        supplierName: s.supplier?.name ?? null,
        approvedVersion: s.approvedVersion
          ? {
              id: s.approvedVersion.id,
              versionNumber: s.approvedVersion.versionNumber,
              reviewDueOn: s.approvedVersion.reviewDueOn,
              approvedAt: now,
            }
          : null,
        draftVersion: s.draftVersion
          ? { id: s.draftVersion.id, versionNumber: s.draftVersion.versionNumber, updatedAt: now }
          : null,
      })),
      total: rows.length,
      today,
    });
  });

  app.get(`${ws}/specifications/:id`, (c) => {
    const s = find(c.req.param("id"));
    return s ? c.json(detail(s)) : c.json(err("not_found", "Specification not found"), 404);
  });

  app.get(`${ws}/specifications/:id/impact`, (c) => {
    const s = find(c.req.param("id"));
    if (!s) return c.json(err("not_found", "Specification not found"), 404);
    const d = detail(s);
    const affected = deps.recipes.filter(
      (r) =>
        r.outputItemId === s.itemId ||
        r.versions.some((v: any) => v.lines.some((l: any) => l.itemId === s.itemId)),
    );
    return c.json({
      specification: { id: s.id, code: s.code, title: s.title, kind: d.kind },
      item: d.item,
      changes: d.draftChanges,
      discrepancies: d.discrepancies,
      draftDiscrepancies: d.draftDiscrepancies,
      recipes: affected.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        status: r.status,
        relation: r.outputItemId === s.itemId ? "makes" : "ingredient",
        depth: r.outputItemId === s.itemId ? 0 : 1,
        outputItem: {
          id: r.outputItemId,
          code: deps.items.find((i) => i.id === r.outputItemId)?.code,
          name: "",
        },
      })),
      labels: [],
      batches: null,
      hidden: ["production"],
      depthLimited: false,
      truncated: [],
      maxDepth: 10,
      today,
    });
  });

  const fromDraft = (input: ReturnType<typeof specificationDraftSchema.parse>) => ({
    ...input,
    parameters: input.parameters.map((p) => ({
      id: newId(),
      unit: null,
      min: null,
      target: null,
      max: null,
      limitText: null,
      method: null,
      note: null,
      ...p,
    })),
  });

  app.post(`${ws}/specifications`, async (c) => {
    const parsed = specificationCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const input = parsed.data;
    if (specs.some((s) => s.code.toLowerCase() === input.code.toLowerCase())) {
      return c.json(err("code_taken", `Another specification already uses the code "${input.code}"`), 409);
    }
    const spec: Spec = {
      id: newId(),
      code: input.code,
      title: input.title,
      itemId: input.itemId,
      supplierId: input.supplierId ?? null,
      customerName: input.customerName ?? null,
      status: "active",
      versions: input.draft ? [version(1, "draft", fromDraft(input.draft))] : [],
    };
    specs.push(spec);
    return c.json(detail(spec), 201);
  });

  app.put(`${ws}/specifications/:id/draft`, async (c) => {
    const s = find(c.req.param("id"));
    if (!s) return c.json(err("not_found", "Specification not found"), 404);
    const parsed = specificationDraftSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const fields = fromDraft(parsed.data);
    const draft = s.versions.find((v) => v.status === "draft");
    if (draft) Object.assign(draft, fields);
    else
      s.versions.push(version(Math.max(0, ...s.versions.map((v) => v.versionNumber)) + 1, "draft", fields));
    return c.json(detail(s));
  });

  return { specifications: specs };
}
