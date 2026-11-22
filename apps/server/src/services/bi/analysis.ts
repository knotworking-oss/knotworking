import {
  BI_ANALYSIS_LIMITS,
  BI_CATALOGUE_VERSION,
  biAnalysisCreateSchema,
  biExpectedMatches,
  biZodIssues,
  checkBiAnalysis,
  evaluateBiFormula,
  parseBiFormula,
  resolveBiPath,
  type BiAnalysisResult,
  type BiAnalysisSource,
  type BiDashboardViewer,
  type BiIssue,
  type ModuleId,
} from "@knotworking/core";
import { biSnapshots, recordChanges, type Database } from "@knotworking/db";
import { ApiError } from "../../errors";
import { moduleOfRoute, workspaceSubPath } from "../../modules/routes";
import type { BiWorkspace } from "./query";

/**
 * Agent analyses (format, paths and formulas in `@knotworking/core`
 * bi/analysis.ts). The server reads every cited source again as the caller, through this app's own
 * routes (so module access, a token's allowlist and every route's own checks apply exactly as when
 * the agent read it), resolves each cited value, evaluates each formula itself, and only then
 * freezes the analysis as a snapshot of kind `analysis`.
 */

/**
 * Modules whose routes an analysis may not read: personal, HR and confidential data (the
 * restricted datasets), the Dashboards module itself, and platform routes.
 */
const UNREADABLE: ReadonlySet<string> = new Set<ModuleId | "platform">([
  "platform",
  "bi",
  "attendance",
  // Incident reports are read by people only (their routes refuse tokens).
  "hse_incidents",
  "workforce",
  "workforce_hr",
  "people",
  "accounting",
  "calendar",
  "assistant",
  "governance",
]);

const invalid = (issues: BiIssue[]) =>
  new ApiError(400, "invalid_analysis", `${issues[0]!.path}: ${issues[0]!.message}`, { issues });

/**
 * Routes of readable modules that need more than `read` (a manager's view of who an SOP targets):
 * figures from them would reach readers with only `read`.
 */
const RESTRICTED_PATHS: readonly RegExp[] = [/^\/sops\/[^/]+\/targets$/];

/** The module a source path belongs to, or why it can't be a source. */
export function sourceModule(path: string): { module: ModuleId } | { error: string } {
  if (path.includes("..") || /\.(csv|pdf|zip)$/i.test(path)) return { error: "not a readable data route" };
  if (RESTRICTED_PATHS.some((r) => r.test(path))) return { error: "this route needs more than read access" };
  const module = moduleOfRoute(path);
  if (!module) return { error: "no such workspace route" };
  if (UNREADABLE.has(module))
    return {
      error: `routes of ${module === "platform" ? "the platform" : `the ${module} module`} can't be cited`,
    };
  return { module: module as ModuleId };
}

/** How the server reaches its own routes as the caller: the request's credential headers. */
export interface SourceReader {
  slug: string;
  headers: Headers;
  fetch: (request: Request) => Promise<Response>;
}

/**
 * Reads one source through the app as the caller: `GET /v1/workspaces/<slug><path>?<query>`. Only
 * JSON answers count; any refusal (403, 404, 400) comes back as the reason.
 */
export async function readSource(
  reader: SourceReader,
  source: Pick<BiAnalysisSource, "path" | "query">,
): Promise<{ answer: unknown; module: ModuleId } | { error: string }> {
  const query = new URLSearchParams(
    Object.entries(source.query ?? {}).map(([k, v]) => [k, String(v)] as [string, string]),
  );
  const url = `http://internal/v1/workspaces/${encodeURIComponent(reader.slug)}${source.path}${query.size ? `?${query}` : ""}`;
  // Classify the route actually requested (after URL normalisation), and refuse a path that a URL
  // would turn into another one: the module recorded is the one whose route was read.
  const requested = workspaceSubPath(new URL(url).pathname);
  if (requested !== source.path) return { error: "not a plain route path" };
  const owner = sourceModule(requested);
  if ("error" in owner) return owner;
  const headers = new Headers();
  for (const name of ["cookie", "authorization"]) {
    const value = reader.headers.get(name);
    if (value) headers.set(name, value);
  }
  const res = await reader.fetch(new Request(url, { method: "GET", headers }));
  if (!/^application\/json\b/i.test(res.headers.get("content-type") ?? "")) {
    await res.body?.cancel().catch(() => {});
    return { error: "the route doesn't answer with JSON" };
  }
  const text = await readCapped(res, BI_ANALYSIS_LIMITS.sourceBytes);
  if (text === null) return { error: "the answer is too large to cite: narrow it with query parameters" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: "the route doesn't answer with JSON" };
  }
  if (!res.ok) {
    const message = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    return { error: `the route refused: ${message}` };
  }
  return { answer: body, module: owner.module };
}

/** A response body as text, or null past `maxBytes` (stops reading there). */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Verifies an analysis and freezes it: every source read again, every cited value found, every
 * formula worked out by the server and checked against the agent's expected figure.
 */
export async function createAnalysis(
  db: Database,
  workspace: BiWorkspace,
  viewer: BiDashboardViewer,
  reader: SourceReader,
  input: unknown,
) {
  const parsed = biAnalysisCreateSchema.safeParse(input);
  if (!parsed.success) throw invalid(biZodIssues(parsed.error));
  const data = parsed.data;
  const structural = checkBiAnalysis(data);
  if (structural.length) throw invalid(structural);

  const issues: BiIssue[] = [];
  const answers = new Map<string, unknown>();
  const modules = new Set<ModuleId>();
  const readAt = new Date().toISOString();
  // One at a time: each is a full module read under the caller's own limits.
  for (const [i, source] of data.sources.entries()) {
    const read = await readSource(reader, source);
    if ("error" in read) issues.push({ path: `sources[${i}]`, message: `${source.path}: ${read.error}` });
    else {
      answers.set(source.id, read.answer);
      modules.add(read.module);
    }
  }
  if (issues.length) throw invalid(issues);

  const figures: BiAnalysisResult["figures"] = data.figures.map((figure, f) => {
    const values: BiAnalysisResult["figures"][number]["values"] = {};
    for (const scenario of data.scenarios) {
      const spec = figure.values[scenario.id]!;
      const at = `figures[${f}].values.${scenario.id}`;
      const inputs: Record<string, { source: string; path: string; value: number | number[] }> = {};
      let ok = true;
      for (const [name, cite] of Object.entries(spec.inputs)) {
        const limit = Number(data.sources.find((src) => src.id === cite.source)?.query.limit);
        const found = resolveBiPath(answers.get(cite.source), cite.path, {
          ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        });
        if ("error" in found) {
          issues.push({
            path: `${at}.inputs.${name}`,
            message: `${cite.source} ${cite.path}: ${found.error}`,
          });
          ok = false;
        } else inputs[name] = { ...cite, value: found.value };
      }
      let value: number | null = null;
      if (ok) {
        const tree = parseBiFormula(spec.formula);
        const result =
          typeof tree === "string" ? { error: tree } : evaluateBiFormula(tree, mapValues(inputs));
        if ("error" in result) issues.push({ path: `${at}.formula`, message: result.error });
        else {
          value = result.value;
          if (spec.expected !== undefined && !biExpectedMatches(spec.expected, value)) {
            issues.push({
              path: `${at}.expected`,
              message: `you expected ${spec.expected}, the cited values give ${value ?? "no value"}: check the inputs and formula`,
            });
          }
        }
      }
      values[scenario.id] = { value, formula: spec.formula, inputs };
    }
    return {
      id: figure.id,
      label: figure.label,
      unit: figure.unit ?? null,
      description: figure.description ?? null,
      values,
    };
  });
  if (issues.length) throw invalid(issues);

  const analysis: BiAnalysisResult = {
    title: data.title,
    question: data.question,
    summary: data.summary ?? null,
    scenarios: data.scenarios,
    sources: data.sources.map((s) => ({ ...s, readAt })),
    figures,
    modules: [...modules].sort(),
    verifiedAt: readAt,
  };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(biSnapshots)
      .values({
        workspaceId: workspace.id,
        kind: "analysis",
        dashboardId: null,
        dashboardVersion: 0,
        title: data.title,
        asAt: workspace.today,
        // An analysis has no dashboard layout; its content is in `results.analysis`.
        spec: { params: { filters: [] }, sections: [{ id: "analysis", title: "", widgets: [] }] },
        results: { analysis },
        catalogueVersion: BI_CATALOGUE_VERSION,
        takenBy: viewer.userId,
      })
      .returning();
    await recordChanges(tx, workspace.id, viewer.userId, [
      {
        entity: "bi_snapshot",
        entityId: row!.id,
        action: "upsert",
        data: {
          id: row!.id,
          kind: row!.kind,
          dashboardId: null,
          dashboardVersion: 0,
          title: row!.title,
          asAt: row!.asAt,
          catalogueVersion: row!.catalogueVersion,
          takenBy: row!.takenBy,
          takenAt: row!.takenAt,
        },
      },
    ]);
    return { id: row!.id, kind: "analysis" as const, title: row!.title, asAt: row!.asAt, analysis };
  });
}

const mapValues = (inputs: Record<string, { value: number | number[] }>) =>
  Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]));
