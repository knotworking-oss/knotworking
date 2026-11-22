import {
  BI_NEVER_REPORTABLE,
  biDatasets,
  isModuleId,
  isNeverReportable,
  type BiColumnRef,
  type BiDataset,
} from "@knotworking/core";
import { describe, expect, it } from "vitest";
import { registeredTable } from "./services/bi/registry";

/** Every column a dataset reads, with the table it is on. */
function references(d: BiDataset): Array<{ where: string; table: string; column: string }> {
  const tableOf = (ref: BiColumnRef) => (ref.join ? d.joins[ref.join]!.table : d.table);
  const out: Array<{ where: string; table: string; column: string }> = [];
  const add = (where: string, ref: BiColumnRef | undefined) => {
    if (ref) out.push({ where, table: tableOf(ref), column: ref.column });
  };
  for (const dim of d.dimensions) {
    add(`dimension ${dim.id}`, dim);
    const labels =
      dim.labelColumn === undefined
        ? []
        : Array.isArray(dim.labelColumn)
          ? dim.labelColumn
          : [dim.labelColumn];
    for (const label of labels) add(`dimension ${dim.id} label`, { join: dim.join, column: label as string });
  }
  for (const m of d.measures) {
    add(`measure ${m.id}`, m.of);
    add(`measure ${m.id} times`, m.times);
    for (const w of m.where ?? []) add(`measure ${m.id} where`, w);
    if (m.convert) {
      add(`measure ${m.id} convert unit`, m.convert.unit);
      // The conversion reads the item's unit, density and unit weight.
      for (const column of ["unit", "density_g_per_ml", "unit_weight_g"]) {
        add(`measure ${m.id} convert item`, { join: m.convert.itemJoin, column });
      }
      expect(d.joins[m.convert.itemJoin]?.table, `${d.id}.${m.id} convert`).toBe("items");
    }
  }
  for (const s of d.scope ?? []) add("scope", s);
  for (const [name, join] of Object.entries(d.joins)) {
    add(`join ${name} key`, { join: join.fromJoin, column: join.from });
    out.push({ where: `join ${name} target`, table: join.table, column: join.to ?? "id" });
  }
  return out;
}

describe("BI catalogue", () => {
  it("has unique dataset ids, and unique field ids within each dataset", () => {
    expect(new Set(biDatasets.map((d) => d.id)).size).toBe(biDatasets.length);
    for (const d of biDatasets.filter((x) => !x.virtual)) {
      const ids = [...d.dimensions, ...d.measures].map((f) => f.id);
      expect(new Set(ids).size, d.id).toBe(ids.length);
      // `__` is reserved for result keys (`supplier__id`, `order_value__compare`).
      for (const id of ids) expect(id, `${d.id}.${id}`).not.toContain("__");
    }
  });

  it("names real modules for every dataset and join", () => {
    for (const d of biDatasets.filter((x) => !x.virtual)) {
      expect(isModuleId(d.module), d.id).toBe(true);
      for (const [name, join] of Object.entries(d.joins)) {
        if (join.module) expect(isModuleId(join.module), `${d.id}.${name}`).toBe(true);
        if (join.fromJoin) expect(d.joins[join.fromJoin], `${d.id}.${name}.fromJoin`).toBeDefined();
      }
    }
  });

  it("maps every column to a real Drizzle column", () => {
    for (const d of biDatasets.filter((x) => !x.virtual)) {
      expect(registeredTable(d.table), `${d.id}: table ${d.table}`).toBeDefined();
      for (const ref of references(d)) {
        const table = registeredTable(ref.table);
        expect(table, `${d.id} ${ref.where}: table ${ref.table}`).toBeDefined();
        expect(table!.columns.has(ref.column), `${d.id} ${ref.where}: ${ref.table}.${ref.column}`).toBe(true);
      }
    }
  });

  it("only reads workspace tables (users only as a lookup by id), and the base table has deleted_at or is a ledger", () => {
    for (const d of biDatasets.filter((x) => !x.virtual)) {
      expect(registeredTable(d.table)!.hasWorkspaceId, `${d.id}: ${d.table}`).toBe(true);
      for (const [name, join] of Object.entries(d.joins)) {
        const table = registeredTable(join.table)!;
        if (!table.hasWorkspaceId) {
          expect(join.table, `${d.id}.${name}`).toBe("users");
          expect(join.kind, `${d.id}.${name}`).toBe("lookup");
        }
      }
    }
    // Tables without soft delete (append-only ledgers, records cancelled or removed by status):
    // listed here so a new dataset on one is a deliberate choice. The compiler excludes
    // soft-deleted rows wherever `deleted_at` exists (bi-query.test.ts proves it).
    const noSoftDelete = new Set([
      "stock_movements",
      "sales_order_lines" /* removed_at, in the dataset scope */,
    ]);
    for (const d of biDatasets.filter((x) => !x.virtual)) {
      expect(registeredTable(d.table)!.hasDeletedAt || noSoftDelete.has(d.table), d.id).toBe(true);
    }
  });

  it("never touches a never-reportable table", () => {
    expect(isNeverReportable("attendance_events")).toBe(true);
    expect(isNeverReportable("workforce_payroll_runs")).toBe(true);
    expect(isNeverReportable("governance_concerns")).toBe(true);
    expect(isNeverReportable("governance_objectives")).toBe(false);
    for (const secret of [
      "api_tokens",
      "api_token_action_log",
      "calendar_connections",
      "sessions",
      "accounts",
      "invitations",
    ]) {
      expect(isNeverReportable(secret), secret).toBe(true);
    }
    for (const d of biDatasets.filter((x) => !x.virtual)) {
      for (const table of [d.table, ...Object.values(d.joins).map((j) => j.table)]) {
        expect(
          isNeverReportable(table),
          `${d.id} reads ${table}, which is on ${BI_NEVER_REPORTABLE.join(", ")}`,
        ).toBe(false);
      }
    }
  });

  it("declares coherent fields: date dimensions as default dates, references with labels, splits that exist", () => {
    for (const d of biDatasets.filter((x) => !x.virtual)) {
      const dims = new Map(d.dimensions.map((x) => [x.id, x]));
      expect(dims.get(d.defaultDate)?.type, `${d.id}.defaultDate`).toBe("date");
      if (d.currencyDimension) expect(dims.get(d.currencyDimension), `${d.id}.currency`).toBeDefined();
      for (const dim of d.dimensions) {
        if (dim.type === "reference") expect(dim.labelColumn, `${d.id}.${dim.id}`).toBeDefined();
        if (dim.instant) expect(dim.type, `${d.id}.${dim.id}`).toBe("date");
      }
      for (const m of d.measures) {
        if (m.agg !== "count") expect(m.of, `${d.id}.${m.id}`).toBeDefined();
        for (const split of m.splitBy ?? [])
          expect(dims.has(split), `${d.id}.${m.id} splitBy ${split}`).toBe(true);
        // Money in a dataset with its own currency column must be split by it.
        if (m.unit === "money" && d.currencyDimension) expect(m.splitBy).toContain(d.currencyDimension);
      }
    }
  });
});
