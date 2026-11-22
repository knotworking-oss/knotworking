import { addDays } from "@knotworking/core";
import type { World, Persona } from "./world";
import type { Master } from "./setup";
import type { Plant } from "./plant";
import type { Rng } from "./rng";

const CCPS = [
  {
    code: "CCP1",
    processStep: "Cooking",
    hazardType: "biological",
    hazard: "Survival of vegetative pathogens",
    limitType: "range",
    limitMin: 75,
    limitUnit: "°C",
    monitoringMethod: "Probe the core",
    frequency: { every: 1, unit: "batch" },
    responsibleRole: "Cook",
    correctiveAction: "Continue cooking to 75 °C",
    verification: "Supervisor reviews daily",
  },
  {
    code: "CCP2",
    processStep: "Blast chilling",
    hazardType: "biological",
    hazard: "Growth of spore formers",
    limitType: "range",
    limitMin: null,
    limitMax: 5,
    limitUnit: "°C",
    monitoringMethod: "Probe",
    frequency: { every: 1, unit: "batch" },
    responsibleRole: "Operative",
    correctiveAction: "Move to working chiller",
    verification: "Daily review",
  },
  {
    code: "CCP3",
    processStep: "Metal detection",
    hazardType: "physical",
    hazard: "Metal fragments",
    limitType: "pass_fail",
    limitMin: null,
    limitUnit: null,
    passCriterion: "Test pieces rejected",
    monitoringMethod: "Test pieces",
    frequency: { every: 1, unit: "day" },
    responsibleRole: "Packer",
    correctiveAction: "Quarantine since last pass",
    verification: "Weekly review",
  },
];

export class Compliance {
  ccpIds: Record<string, string> = {};
  assets: { id: string; kind: string }[] = [];
  staff: { id: string; userId: string }[] = [];
  courses: string[] = [];
  readingsLogged = 0;
  deviations = 0;
  deviationMismatch = 0;
  stats: Record<string, number> = {};
  private seenBatches = new Set<string>();
  constructor(
    private w: World,
    private m: Master,
    private rng: Rng,
  ) {}
  private p = (k: string): Persona => this.w.people.get(k)!;
  private bump(k: string, n = 1) {
    this.stats[k] = (this.stats[k] ?? 0) + n;
  }

  async setup(today: string) {
    const qa = this.p("qaMgr");
    const plan = await this.w.call(
      qa,
      "POST",
      "/haccp/plans",
      {
        code: "HACCP-01",
        name: "Main site HACCP plan",
        draft: {
          scope: { itemIds: this.m.products.map((x) => x.id) },
          scopeNote: "All finished products",
          ccps: CCPS,
        },
      },
      [201],
    );
    if (plan.body?.id) {
      const ap = await this.w.call(
        this.p("md"),
        "POST",
        `/haccp/plans/${plan.body.id}/draft/approve`,
        {},
        [200],
      );
      for (const c of ap.body?.ccps ?? []) this.ccpIds[c.code] = c.id;
    }
    for (const [i, name] of ["Line 1", "Line 2", "Packing hall"].entries())
      this.assets.push({
        id: (
          await this.w.call(
            qa,
            "POST",
            "/haccp/assets",
            { kind: "area", code: `AR${i}`, name, cleaningFrequency: { every: 1, unit: "day" } },
            [201],
          )
        ).body?.id,
        kind: "area",
      });
    for (const [i, name] of ["Probe 1", "Probe 2"].entries())
      this.assets.push({
        id: (
          await this.w.call(
            qa,
            "POST",
            "/haccp/assets",
            {
              kind: "equipment",
              code: `PRB${i}`,
              name,
              calibrationFrequency: { every: 1, unit: "month" },
              calibrationTolerance: 0.5,
              measurementUnit: "°C",
            },
            [201],
          )
        ).body?.id,
        kind: "equipment",
      });
    // Staff records for everyone, linked to their login, and the courses they need.
    for (const person of this.w.people.values()) {
      const [first, ...rest] = person.name.split(" ");
      const r = await this.w.call(
        this.p("hr"),
        "POST",
        "/people/staff",
        {
          firstName: first,
          lastName: rest.join(" ") || "-",
          jobTitle: person.title,
          department: "Site",
          startDate: addDays(today, -rng0(this.rng, 30, 2000)),
          userId: person.userId,
        },
        [201],
      );
      if (r.body?.id) this.staff.push({ id: r.body.id, userId: person.userId });
    }
    for (const [code, title, kind, months] of [
      ["FSA1", "Food safety level 2", "certificate", 36],
      ["IND1", "Site induction", "induction", null],
      ["ALG1", "Allergen awareness", "certificate", 12],
      ["MD1", "Metal detector operation", "on_the_job", 12],
      ["FAW", "First aid at work", "certificate", 36],
    ] as const) {
      const c = await this.w.call(
        this.p("hr"),
        "POST",
        "/training/courses",
        { code, title, kind, ...(months ? { validityMonths: months } : {}) },
        [201],
      );
      if (c.body?.id) this.courses.push(c.body.id);
    }
    // Everyone completes induction and food safety on day one.
    const ids = this.staff.map((s) => s.id);
    for (const c of this.courses.slice(0, 3))
      await this.w.call(
        this.p("hr"),
        "POST",
        "/training/records",
        { staffIds: ids, courseId: c, completedOn: today, trainerName: "External provider" },
        [201],
      );
  }

  /** Daily food-safety routine after production: CCP readings on today's batches, cleaning, verification. */
  async daily(today: string, plant: Plant) {
    const qaTech = this.p("qaTech");
    for (const b of plant.batchLog.filter((x) => x.day === today && !this.seenBatches.has(x.batchId))) {
      this.seenBatches.add(b.batchId);
      for (const [code, spec] of [
        ["CCP1", { min: 75, max: null }],
        ["CCP2", { min: null, max: 5 }],
      ] as const) {
        const id = this.ccpIds[code];
        if (!id) continue;
        const bad = this.rng.chance(0.04);
        const value =
          code === "CCP1"
            ? bad
              ? 70 + this.rng.next() * 4
              : 76 + this.rng.next() * 12
            : bad
              ? 6 + this.rng.next() * 3
              : 1 + this.rng.next() * 3.5;
        const v = Math.round(value * 10) / 10;
        const inLimits = (spec.min === null || v >= spec.min) && (spec.max === null || v <= spec.max);
        const r = await this.w.call(
          qaTech,
          "POST",
          "/haccp/logs",
          { ccpId: id, value: v, batchId: b.batchId },
          [201, 400, 409],
        );
        if (!r.ok) continue;
        this.readingsLogged++;
        if (r.body.withinLimits !== inLimits) {
          this.deviationMismatch++;
          this.w.findings.record({
            kind: "invariant",
            day: today,
            who: "compliance",
            what: "server judged a CCP reading differently from the critical limit",
            detail: { code, v, inLimits, server: r.body.withinLimits },
          });
        }
        if (!inLimits) {
          this.deviations++;
          const ca = await this.w.call(
            this.p("qaMgr"),
            "POST",
            "/haccp/corrective-actions",
            { title: `${code} deviation ${v}`, logId: r.body.id, lotId: undefined },
            [201, 400],
          );
          if (ca.body?.id) {
            await this.w.call(
              this.p("qaMgr"),
              "PATCH",
              `/haccp/corrective-actions/${ca.body.id}`,
              {
                rootCause: "Equipment drift",
                actionTaken: "Reprocessed and re-checked",
                preventiveAction: "Added to calibration schedule",
              },
              [200, 400],
            );
            await this.w.call(
              this.p("md"),
              "POST",
              `/haccp/corrective-actions/${ca.body.id}/close`,
              { verificationNote: "Re-test within limits" },
              [200, 400, 404],
            );
          }
        }
      }
    }
    // Metal detector test once a day.
    if (this.ccpIds.CCP3)
      await this.w.call(qaTech, "POST", "/haccp/logs", { ccpId: this.ccpIds.CCP3, passed: true }, [201, 400]);
    // Clean each area; a different person verifies (four-eyes).
    for (const a of this.assets.filter((x) => x.kind === "area" && x.id)) {
      const op = this.p(this.rng.pick(["op1", "op2", "op3"]));
      const c = await this.w.call(op, "POST", "/haccp/cleaning", { assetId: a.id }, [201, 403]);
      if (!c.body?.id) continue;
      this.bump("cleaning");
      const self = await this.w.call(op, "POST", `/haccp/cleaning/${c.body.id}/verify`, {}, [403]);
      if (self.status === 200 || self.status === 201)
        this.w.findings.record({
          kind: "invariant",
          day: today,
          who: "compliance",
          what: "cleaning verified by the same person who did it (four-eyes broken)",
        });
      await this.w.call(qaTech, "POST", `/haccp/cleaning/${c.body.id}/verify`, {}, [200, 403]);
    }
  }

  /** Customer complaints, non-conformances and the occasional mock recall. */
  async quality(today: string, plant: Plant) {
    const q = this.p("qaMgr");
    if (this.rng.chance(0.25) && plant.despatchLog.length) {
      const d = this.rng.pick(plant.despatchLog);
      const c = await this.w.call(
        this.p("salesMgr"),
        "POST",
        "/quality/complaints",
        {
          receivedOn: today,
          source: "customer",
          category: this.rng.pick(["quality", "packaging", "foreign_body", "labelling"]),
          severity: this.rng.pick(["minor", "major"]),
          description: "Customer reports an issue with delivered product",
          lotId: d.lotIds[0],
        },
        [201, 403],
      );
      if (c.body?.id) {
        this.bump("complaints");
        if (this.rng.chance(0.4)) {
          const n = await q_call(this.w, q, "POST", "/quality/nonconformances", {
            raisedOn: today,
            source: "complaint",
            complaintId: c.body.id,
            title: "Complaint investigation",
            description: "Root cause investigation",
            severity: "minor",
          });
          if (n) this.bump("ncrs");
        }
        if (this.rng.chance(0.7))
          await this.w.call(
            q,
            "POST",
            `/quality/complaints/${c.body.id}/close`,
            { response: "Apology and replacement sent", justified: this.rng.chance(0.6) },
            [200, 400, 409],
          );
      }
    }
    if (this.rng.chance(0.08))
      await q_call(this.w, q, "POST", "/quality/nonconformances", {
        raisedOn: today,
        source: "process",
        title: "Process deviation on line",
        description: "Operator skipped a check",
        severity: "minor",
      });
  }

  async mockRecall(today: string, plant: Plant) {
    const b = plant.batchLog.filter((x) => x.outputLotId).at(-3);
    if (!b?.outputLotId) return;
    const r = await this.w.call(
      this.p("qaMgr"),
      "POST",
      "/quality/recall-tests",
      {
        conductedOn: today,
        lotId: b.outputLotId,
        direction: "both",
        scenario: "Annual mock recall",
        startedAt: `${today}T09:00:00Z`,
        completedAt: `${today}T10:30:00Z`,
        quantityExpected: 100,
        quantityTraced: 100,
      },
      [201, 400, 409],
    );
    if (r.ok) this.bump("recall_tests");
  }

  /** Staff turnover: a leaver is deactivated, a joiner invited, trained and given access. */
  async refreshTraining(today: string) {
    const due = await this.w.call(this.p("hr"), "GET", "/training/due");
    const rows: any[] = due.body?.due ?? due.body?.records ?? due.body?.items ?? [];
    this.bump("training_due_rows", Array.isArray(rows) ? rows.length : 0);
    const ids = this.staff.map((s) => s.id);
    // Annual refreshers.
    for (const c of this.courses.slice(2, 4))
      await this.w.call(
        this.p("hr"),
        "POST",
        "/training/records",
        { staffIds: ids, courseId: c, completedOn: today, trainerName: "Trainer" },
        [201, 400, 409],
      );
  }
}

async function q_call(w: World, who: Persona, method: string, path: string, body: unknown) {
  const r = await w.call(who, method, path, body, [201, 400, 403]);
  return r.body?.id as string | undefined;
}
const rng0 = (rng: Rng, a: number, b: number) => rng.int(a, b);
