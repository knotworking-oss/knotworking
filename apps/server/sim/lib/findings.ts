import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Finding {
  kind: "server_error" | "unexpected_status" | "invariant" | "scenario";
  day: string;
  who: string;
  what: string;
  detail?: unknown;
}

/** Collects findings, collapsing repeats so a systematic problem is one row with a count. */
export class Findings {
  private rows = new Map<string, Finding & { count: number; first: string }>();
  record(f: Finding) {
    const key = `${f.kind}|${f.what}`;
    const hit = this.rows.get(key);
    if (hit) hit.count++;
    else this.rows.set(key, { ...f, count: 1, first: f.day });
  }
  get all() {
    return [...this.rows.values()];
  }
  count(kind?: Finding["kind"]) {
    return this.all.filter((f) => !kind || f.kind === kind).reduce((n, f) => n + f.count, 0);
  }
  save(path: string, meta: object) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ meta, findings: this.all }, null, 2));
  }
}
