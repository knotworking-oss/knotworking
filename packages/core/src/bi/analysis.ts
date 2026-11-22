import { z } from "zod";
import type { BiIssue } from "./query";

/**
 * Agent analyses: a comparison of scenarios ("as things stand" against "if
 * we cancelled PO-2026-014") that an agent assembles from what it read through the workspace's own
 * API, and that the server verifies before freezing it as a snapshot.
 *
 * Every figure is a formula over values cited from sources. A source is a read of a workspace API
 * route (the same routes the MCP tools call). On save the server reads each source again as the
 * caller, looks up every cited value in the answer, evaluates every formula itself, and refuses the
 * analysis if a source fails, a value isn't where it is cited, a list is incomplete, or a figure the
 * agent expected doesn't match. Nothing in an analysis is a number the agent typed in: the agent
 * supplies the reasoning (which data, which formula, what is assumed), the server the arithmetic.
 *
 * Pure: the server and the MCP test double share these functions.
 */

export const BI_ANALYSIS_LIMITS = {
  sources: 30,
  scenarios: 4,
  figures: 60,
  inputsPerValue: 20,
  formulaLength: 500,
  textLength: 4000,
  /** Largest source answer read, in bytes of JSON. */
  sourceBytes: 2_000_000,
} as const;

const idSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "Use 1-40 letters, digits or _, starting with a letter");

/** Query values a source passes: scalars only. */
const queryValue = z.union([z.string().max(500), z.number(), z.boolean()]);

/**
 * A read of a workspace API route: `path` below `/v1/workspaces/<slug>` (e.g.
 * `/purchasing/orders/0190…` or `/production/requirements`) and its query parameters.
 */
export const biAnalysisSourceSchema = z.object({
  id: idSchema,
  path: z
    .string()
    .trim()
    .max(300)
    // Segments of only dots ("." or "..") are refused: a URL would resolve them away, so the route
    // read could differ from the one the path names.
    .regex(
      /^(\/(?!\.+(\/|$))[A-Za-z0-9._~-]+)+$/,
      "A path below the workspace, like /purchasing/orders/<id>",
    ),
  query: z.record(z.string().max(60), queryValue).default({}),
  /** What this source is, for readers ("open purchase orders from Millers"). */
  note: z.string().trim().max(300).optional(),
});
export type BiAnalysisSource = z.infer<typeof biAnalysisSourceSchema>;

/** A cited value: where in which source's answer it is (see `resolveBiPath`). */
export const biAnalysisInputSchema = z.object({
  source: idSchema,
  path: z.string().trim().min(1).max(300),
});

export const biAnalysisValueSchema = z.object({
  /** Arithmetic over the input names: + - * / ( ), sum(), count(), min(), max(), abs(), round(x, n). */
  formula: z.string().trim().min(1).max(BI_ANALYSIS_LIMITS.formulaLength),
  inputs: z.record(idSchema, biAnalysisInputSchema).default({}),
  /** What the agent worked out: a mismatch with the server's result refuses the save. */
  expected: z.number().nullable().optional(),
});
export type BiAnalysisValueInput = z.infer<typeof biAnalysisValueSchema>;

export const biAnalysisCreateSchema = z.object({
  title: z.string().trim().min(1).max(160),
  /** The question asked, in the asker's words. */
  question: z.string().trim().min(1).max(1000),
  /** The agent's narrative: labelled as commentary, never a figure of record. */
  summary: z.string().trim().max(BI_ANALYSIS_LIMITS.textLength).optional(),
  scenarios: z
    .array(
      z.object({
        id: idSchema,
        label: z.string().trim().min(1).max(120),
        /** What the scenario assumes, in plain words ("PO-2026-014 is cancelled and not replaced"). */
        assumptions: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(BI_ANALYSIS_LIMITS.scenarios),
  sources: z.array(biAnalysisSourceSchema).min(1).max(BI_ANALYSIS_LIMITS.sources),
  figures: z
    .array(
      z.object({
        id: idSchema,
        label: z.string().trim().min(1).max(160),
        /** Shown after the value: "kg", "weeks", "GBP", "%". */
        unit: z.string().trim().max(20).optional(),
        /** How the figure is worked out, for readers. */
        description: z.string().trim().max(500).optional(),
        /** Scenario id → how the figure is worked out in that scenario. */
        values: z.record(idSchema, biAnalysisValueSchema),
      }),
    )
    .min(1)
    .max(BI_ANALYSIS_LIMITS.figures),
});
export type BiAnalysisCreateInput = z.input<typeof biAnalysisCreateSchema>;
export type BiAnalysisCreate = z.infer<typeof biAnalysisCreateSchema>;

/** A verified analysis as stored in its snapshot. */
export interface BiAnalysisResult {
  title: string;
  question: string;
  summary: string | null;
  scenarios: Array<{ id: string; label: string; assumptions: string }>;
  sources: Array<BiAnalysisSource & { readAt: string }>;
  figures: Array<{
    id: string;
    label: string;
    unit: string | null;
    description: string | null;
    values: Record<
      string,
      {
        value: number | null;
        formula: string;
        /** Every cited value, as read. */
        inputs: Record<string, { source: string; path: string; value: number | number[] }>;
      }
    >;
  }>;
  /** The modules whose routes the sources read: a reader needs each to see the figures. */
  modules: string[];
  verifiedAt: string;
}

// ─── Paths into a source's answer ───────────────────────────────────────────

type PathStep =
  | { kind: "key"; key: string }
  | { kind: "index"; index: number }
  | { kind: "all" }
  | { kind: "match"; field: string[]; value: string };

/**
 * Parses a path: `order.lines[0].quantity`, `items[*].required` (every element), and
 * `levels[item.code=FLR-01].onHand` (the one element whose field equals the text).
 */
export function parseBiPath(path: string): PathStep[] | string {
  const steps: PathStep[] = [];
  let i = 0;
  const readKey = () => {
    const m = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(path.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  while (i < path.length) {
    if (path[i] === ".") {
      i++;
      const key = readKey();
      if (!key) return `expected a name after '.' at ${i}`;
      steps.push({ kind: "key", key });
    } else if (path[i] === "[") {
      const end = path.indexOf("]", i);
      if (end < 0) return "a '[' is never closed";
      const inner = path.slice(i + 1, end).trim();
      i = end + 1;
      if (inner === "*") steps.push({ kind: "all" });
      else if (/^\d+$/.test(inner)) steps.push({ kind: "index", index: Number(inner) });
      else {
        const eq = inner.indexOf("=");
        if (eq <= 0) return `'[${inner}]' is not an index, * or field=value`;
        const field = inner.slice(0, eq).trim().split(".");
        if (field.some((f) => !/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(f))) return `bad field in '[${inner}]'`;
        steps.push({ kind: "match", field, value: inner.slice(eq + 1).trim() });
      }
    } else if (steps.length === 0) {
      const key = readKey();
      if (!key) return `unexpected '${path[i]}' at ${i}`;
      steps.push({ kind: "key", key });
    } else return `unexpected '${path[i]}' at ${i}`;
  }
  return steps.length ? steps : "empty path";
}

const asNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())
      ? Number(v)
      : null;

/**
 * Whether a list is only part of the answer: the object carrying it says so (a page: `total`
 * larger than the list, `truncated`, `hasMore`, `nextCursor`, `coverage.status` "partial"), or the
 * source asked for `limit` rows and got exactly that many (a route that caps without saying so).
 */
function isPartial(holder: unknown, list: unknown[], limit: number | undefined): boolean {
  if (limit !== undefined && list.length >= limit) return true;
  if (!holder || typeof holder !== "object" || Array.isArray(holder)) return false;
  const h = holder as Record<string, unknown>;
  if (h.truncated === true || h.hasMore === true) return true;
  if (typeof h.nextCursor === "string" && h.nextCursor) return true;
  const coverage = h.coverage as { status?: unknown } | undefined;
  if (coverage && typeof coverage === "object" && coverage.status === "partial") return true;
  return typeof h.total === "number" && h.total > list.length;
}

/**
 * Looks a cited value up in a source's answer: one number, or (through `[*]`) a list of numbers.
 * Refuses a value that isn't a number, a `field=value` that matches no element or more than one,
 * and a `[*]` over a list the answer says is incomplete (paged or truncated): a total over part of
 * the data would read as the whole.
 */
export function resolveBiPath(
  answer: unknown,
  path: string,
  options: { limit?: number } = {},
): { value: number | number[] } | { error: string } {
  const steps = parseBiPath(path);
  if (typeof steps === "string") return { error: steps };
  // Each node travels with the object that held it, so a list's completeness is judged by its own
  // holder (not the last one seen), however deep the path goes.
  let current: Array<{ node: unknown; holder: unknown }> = [{ node: answer, holder: undefined }];
  let many = false;
  for (const step of steps) {
    const next: Array<{ node: unknown; holder: unknown }> = [];
    for (const { node, holder } of current) {
      if (step.kind === "key") {
        // Keys address objects only: `orders.length` would count part of a paged list unchecked.
        if (!node || typeof node !== "object" || Array.isArray(node) || !Object.hasOwn(node, step.key))
          return { error: `no '${step.key}' there` };
        next.push({ node: (node as Record<string, unknown>)[step.key], holder: node });
      } else {
        if (!Array.isArray(node)) return { error: "not a list" };
        if (step.kind === "index") {
          if (step.index >= node.length) return { error: `the list has ${node.length} entries` };
          next.push({ node: node[step.index], holder: node });
        } else if (step.kind === "all") {
          if (isPartial(holder, node, options.limit))
            return {
              error: "the list is only part of the answer (paged, limited or truncated): narrow the source",
            };
          for (const el of node) next.push({ node: el, holder: node });
          many = true;
        } else {
          const hits = node.filter((el) => {
            let v: unknown = el;
            for (const f of step.field)
              v =
                v && typeof v === "object" && Object.hasOwn(v, f)
                  ? (v as Record<string, unknown>)[f]
                  : undefined;
            return v !== undefined && v !== null && String(v) === step.value;
          });
          if (hits.length !== 1) {
            if (hits.length === 0 && isPartial(holder, node, options.limit))
              return {
                error: `no entry with ${step.field.join(".")}=${step.value} in this part of the list`,
              };
            return {
              error: `${hits.length === 0 ? "no entry" : `${hits.length} entries`} with ${step.field.join(".")}=${step.value}`,
            };
          }
          next.push({ node: hits[0], holder: node });
        }
      }
    }
    current = next;
  }
  const numbers: number[] = [];
  for (const { node } of current) {
    const n = asNumber(node);
    if (n === null) return { error: "not a number" };
    numbers.push(n);
  }
  return many ? { value: numbers } : { value: numbers[0]! };
}

// ─── Formulas ───────────────────────────────────────────────────────────────

type Node =
  | { kind: "num"; value: number }
  | { kind: "name"; name: string }
  | { kind: "neg"; arg: Node }
  | { kind: "bin"; op: "+" | "-" | "*" | "/"; left: Node; right: Node }
  | { kind: "call"; fn: string; args: Node[] };

const FUNCTIONS = new Set(["sum", "count", "min", "max", "abs", "round"]);

/** Parses a formula; returns the tree or the first problem. */
export function parseBiFormula(source: string): Node | string {
  const tokens = source.match(/\d*\.\d+|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/(),]|\S/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  function primary(): Node | string {
    const t = take();
    if (t === undefined) return "the formula ends too soon";
    if (/^\d|^\.\d/.test(t)) return { kind: "num", value: Number(t) };
    if (t === "+") return primary();
    if (t === "-") {
      const arg = primary();
      return typeof arg === "string" ? arg : { kind: "neg", arg };
    }
    if (t === "(") {
      const inner = expr();
      if (typeof inner === "string") return inner;
      if (take() !== ")") return "a '(' is never closed";
      return inner;
    }
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === "(") {
        if (!FUNCTIONS.has(t)) return `unknown function '${t}': use ${[...FUNCTIONS].join(", ")}`;
        take();
        const args: Node[] = [];
        if (peek() !== ")") {
          for (;;) {
            const a = expr();
            if (typeof a === "string") return a;
            args.push(a);
            if (peek() === ",") take();
            else break;
          }
        }
        if (take() !== ")") return `'${t}(' is never closed`;
        return { kind: "call", fn: t, args };
      }
      return { kind: "name", name: t };
    }
    return `unexpected '${t}'`;
  }
  function term(): Node | string {
    let left = primary();
    while (typeof left !== "string" && (peek() === "*" || peek() === "/")) {
      const op = take() as "*" | "/";
      const right = primary();
      if (typeof right === "string") return right;
      left = { kind: "bin", op, left, right };
    }
    return left;
  }
  function expr(): Node | string {
    let left = term();
    while (typeof left !== "string" && (peek() === "+" || peek() === "-")) {
      const op = take() as "+" | "-";
      const right = term();
      if (typeof right === "string") return right;
      left = { kind: "bin", op, left, right };
    }
    return left;
  }
  const tree = expr();
  if (typeof tree !== "string" && pos < tokens.length) return `unexpected '${tokens[pos]}'`;
  return tree;
}

/** The input names a formula uses. */
export function biFormulaNames(tree: Node): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    if (n.kind === "name") out.add(n.name);
    else if (n.kind === "neg") walk(n.arg);
    else if (n.kind === "bin") (walk(n.left), walk(n.right));
    else if (n.kind === "call") n.args.forEach(walk);
  };
  walk(tree);
  return [...out];
}

/**
 * Evaluates a formula over input values. Lists (from `[*]` inputs) are only allowed inside sum,
 * count, min and max. Division by zero gives `null` (shown as no value), never Infinity.
 */
export function evaluateBiFormula(
  tree: Node,
  values: Record<string, number | number[]>,
): { value: number | null } | { error: string } {
  class Fail extends Error {}
  const scalar = (v: number | number[] | null): number | null => {
    if (Array.isArray(v)) throw new Fail("a list can only be used inside sum, count, min or max");
    return v;
  };
  const ev = (n: Node): number | number[] | null => {
    switch (n.kind) {
      case "num":
        return n.value;
      case "name": {
        if (!(n.name in values)) throw new Fail(`'${n.name}' is not an input`);
        return values[n.name]!;
      }
      case "neg": {
        const v = scalar(ev(n.arg));
        return v === null ? null : -v;
      }
      case "bin": {
        const a = scalar(ev(n.left));
        const b = scalar(ev(n.right));
        if (a === null || b === null) return null;
        if (n.op === "+") return a + b;
        if (n.op === "-") return a - b;
        if (n.op === "*") return a * b;
        return b === 0 ? null : a / b;
      }
      case "call": {
        const args = n.args.map(ev);
        const flat = (): number[] | null => {
          const out: number[] = [];
          for (const a of args) {
            if (a === null) return null;
            if (Array.isArray(a)) for (const x of a) out.push(x);
            else out.push(a);
          }
          return out;
        };
        switch (n.fn) {
          case "sum": {
            const xs = flat();
            return xs === null ? null : xs.reduce((t, x) => t + x, 0);
          }
          case "count": {
            const xs = flat();
            return xs === null ? null : xs.length;
          }
          case "min":
          case "max": {
            const xs = flat();
            if (xs === null || xs.length === 0) return null;
            let best = xs[0]!;
            for (const x of xs) if (n.fn === "min" ? x < best : x > best) best = x;
            return best;
          }
          case "abs": {
            if (args.length !== 1) throw new Fail("abs takes one value");
            const v = scalar(args[0]!);
            return v === null ? null : Math.abs(v);
          }
          case "round": {
            if (args.length < 1 || args.length > 2) throw new Fail("round takes a value and optional places");
            const v = scalar(args[0]!);
            const places = args[1] === undefined ? 0 : scalar(args[1]!);
            if (v === null || places === null) return null;
            return roundHalfAway(v, Math.max(0, Math.min(6, Math.trunc(places))));
          }
        }
        throw new Fail(`unknown function '${n.fn}'`);
      }
    }
  };
  try {
    const v = ev(tree);
    if (Array.isArray(v)) return { error: "the result is a list: wrap it in sum, count, min or max" };
    if (v !== null && !Number.isFinite(v)) return { value: null };
    return { value: v === null ? null : Math.round(v * 1e6) / 1e6 };
  } catch (err) {
    if (err instanceof Fail) return { error: err.message };
    throw err;
  }
}

/**
 * Rounds half away from zero, as people do (2.5 → 3, -2.5 → -3, 1.005 → 1.01 at 2 places): through
 * the decimal text, so binary fractions like 1.005 don't round down.
 */
function roundHalfAway(value: number, places: number): number {
  const sign = value < 0 ? -1 : 1;
  const shifted = Number(`${Math.abs(value)}e${places}`);
  return (sign * Math.round(shifted)) / 10 ** places || 0;
}

/** Whether the server's figure matches the agent's: within 0.5%, or 0.001 near zero. */
export const biExpectedMatches = (expected: number | null, actual: number | null) =>
  expected === null || actual === null
    ? expected === actual
    : Math.abs(expected - actual) <= Math.max(0.001, Math.abs(actual) * 0.005);

/**
 * Structural checks before any source is read: scenario and source ids unique, every figure has a
 * value for every scenario, every formula parses, and its names are exactly its inputs, each
 * citing a declared source.
 */
export function checkBiAnalysis(input: BiAnalysisCreate): BiIssue[] {
  const issues: BiIssue[] = [];
  const dup = (list: string[], path: string) =>
    list.forEach((id, i) => {
      if (list.indexOf(id) !== i) issues.push({ path: `${path}[${i}].id`, message: `'${id}' is used twice` });
    });
  dup(
    input.scenarios.map((s) => s.id),
    "scenarios",
  );
  dup(
    input.sources.map((s) => s.id),
    "sources",
  );
  dup(
    input.figures.map((f) => f.id),
    "figures",
  );
  const scenarioIds = input.scenarios.map((s) => s.id);
  const sourceIds = new Set(input.sources.map((s) => s.id));
  input.figures.forEach((figure, f) => {
    // A figure must rest on the data somewhere: one made only of numbers typed into formulas would
    // be badged as verified while verifying nothing.
    if (Object.values(figure.values).every((v) => Object.keys(v.inputs).length === 0)) {
      issues.push({
        path: `figures[${f}].values`,
        message:
          "cite at least one source value in some scenario: a figure of typed-in numbers only can't be verified",
      });
    }
    for (const s of scenarioIds) {
      if (!figure.values[s])
        issues.push({ path: `figures[${f}].values`, message: `no value for scenario '${s}'` });
    }
    for (const [scenario, value] of Object.entries(figure.values)) {
      const at = `figures[${f}].values.${scenario}`;
      if (!scenarioIds.includes(scenario)) {
        issues.push({
          path: at,
          message: `unknown scenario '${scenario}'. Scenarios: ${scenarioIds.join(", ")}`,
        });
        continue;
      }
      if (Object.keys(value.inputs).length > BI_ANALYSIS_LIMITS.inputsPerValue)
        issues.push({ path: `${at}.inputs`, message: `at most ${BI_ANALYSIS_LIMITS.inputsPerValue} inputs` });
      const tree = parseBiFormula(value.formula);
      if (typeof tree === "string") {
        issues.push({ path: `${at}.formula`, message: tree });
        continue;
      }
      const names = biFormulaNames(tree);
      for (const n of names)
        if (!(n in value.inputs))
          issues.push({ path: `${at}.formula`, message: `'${n}' is not one of its inputs` });
      for (const [name, cite] of Object.entries(value.inputs)) {
        if (!names.includes(name))
          issues.push({ path: `${at}.inputs.${name}`, message: `'${name}' isn't used in the formula` });
        if (!sourceIds.has(cite.source))
          issues.push({ path: `${at}.inputs.${name}.source`, message: `unknown source '${cite.source}'` });
        const steps = parseBiPath(cite.path);
        if (typeof steps === "string") issues.push({ path: `${at}.inputs.${name}.path`, message: steps });
      }
    }
  });
  return issues;
}
