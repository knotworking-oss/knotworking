"use client";

import type { BiAnalysisResult } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { BadgeCheck, ChevronRight, Lock } from "lucide-react";
import { Fragment, useState } from "react";

/** An analysis as the API shows it: `hidden` when the reader can't read every source's module. */
export type AnalysisForView = BiAnalysisResult & { hidden?: boolean };

const number = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
const show = (value: number | null, unit: string | null) =>
  value === null ? "–" : `${number.format(value)}${unit ? (unit === "%" ? "%" : ` ${unit}`) : ""}`;

/**
 * A verified agent analysis: the question, each scenario with what it
 * assumes, a table of every figure per scenario with its change from the first (baseline), and,
 * per figure, where each number came from: the formula, every cited value and the source read.
 */
export function AnalysisView({ analysis, base }: { analysis: AnalysisForView; base: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [first, ...others] = analysis.scenarios;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="gap-1">
          <BadgeCheck className="size-3.5" /> Agent analysis, sources verified
        </Badge>
        <span className="text-xs text-muted-foreground">
          Every figure was worked out by Knotworking from the cited sources, read on{" "}
          {new Date(analysis.verifiedAt).toLocaleString("en-GB")}.
        </span>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Question</p>
        <p className="text-sm">{analysis.question}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {analysis.scenarios.map((s, i) => (
          <div key={s.id} className="rounded-md border p-3">
            <p className="text-sm font-medium">
              {s.label}
              {i === 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">baseline</span>}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">Assumes: {s.assumptions}</p>
          </div>
        ))}
      </div>
      {analysis.hidden && (
        <p className="flex items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          <Lock className="size-4" /> The figures use data you can't read ({analysis.modules.join(", ")}), so
          they are hidden.
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Figure</th>
              {analysis.scenarios.map((s) => (
                <th key={s.id} className="px-3 py-2 text-right font-medium">
                  {s.label}
                </th>
              ))}
              {others.map((s) => (
                <th key={`d-${s.id}`} className="px-3 py-2 text-right font-medium">
                  Change: {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {analysis.figures.map((f) => {
              const baseValue = first ? (f.values[first.id]?.value ?? null) : null;
              const isOpen = open === f.id;
              return (
                <Fragment key={f.id}>
                  <tr className="border-b last:border-0">
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="flex items-center gap-1 text-left hover:underline disabled:no-underline"
                        aria-expanded={isOpen}
                        disabled={analysis.hidden}
                        onClick={() => setOpen(isOpen ? null : f.id)}
                      >
                        {!analysis.hidden && (
                          <ChevronRight
                            className={`size-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`}
                          />
                        )}
                        {f.label}
                      </button>
                      {f.description && <p className="text-xs text-muted-foreground">{f.description}</p>}
                    </td>
                    {analysis.scenarios.map((s) => (
                      <td key={s.id} className="px-3 py-2 text-right tabular-nums">
                        {show(f.values[s.id]?.value ?? null, f.unit)}
                      </td>
                    ))}
                    {others.map((s) => {
                      const v = f.values[s.id]?.value ?? null;
                      const d =
                        v === null || baseValue === null ? null : Math.round((v - baseValue) * 1e6) / 1e6;
                      return (
                        <td key={`d-${s.id}`} className="px-3 py-2 text-right font-medium tabular-nums">
                          {d === null ? "–" : `${d > 0 ? "+" : ""}${show(d, f.unit)}`}
                        </td>
                      );
                    })}
                  </tr>
                  {isOpen && (
                    <tr className="border-b bg-muted/30">
                      <td colSpan={1 + analysis.scenarios.length + others.length} className="px-3 py-3">
                        <Trace analysis={analysis} figure={f} base={base} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {analysis.summary && (
        <div className="rounded-md border-l-4 bg-muted/40 p-3 text-sm">
          <p className="mb-1 text-xs text-muted-foreground">The agent's commentary, not a figure of record</p>
          <p className="whitespace-pre-wrap">{analysis.summary}</p>
        </div>
      )}
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-sm font-medium hover:underline">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" /> Sources (
          {analysis.sources.length})
        </summary>
        <ul className="mt-2 flex flex-col gap-1 text-xs">
          {analysis.sources.map((src) => (
            <li key={src.id}>
              <code className="text-muted-foreground">{src.id}</code>: {src.note ?? "a workspace read"}{" "}
              <code>
                GET {src.path}
                {Object.keys(src.query ?? {}).length
                  ? `?${new URLSearchParams(src.query as Record<string, string>)}`
                  : ""}
              </code>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** Where one figure came from in each scenario: its formula and every cited value. */
function Trace({
  analysis,
  figure,
  base,
}: {
  analysis: AnalysisForView;
  figure: AnalysisForView["figures"][number];
  base: string;
}) {
  const sources = new Map(analysis.sources.map((s) => [s.id, s]));
  return (
    <div className="flex flex-col gap-3 text-xs">
      {analysis.scenarios.map((s) => {
        const v = figure.values[s.id];
        if (!v) return null;
        return (
          <div key={s.id} className="flex flex-col gap-1">
            <p className="font-medium">
              {s.label}: <code className="font-normal">{v.formula}</code> = {show(v.value, figure.unit)}
            </p>
            {Object.entries(v.inputs).length > 0 && (
              <ul className="flex flex-col gap-0.5 pl-3">
                {Object.entries(v.inputs).map(([name, input]) => {
                  const src = sources.get(input.source);
                  return (
                    <li key={name}>
                      <code>{name}</code> ={" "}
                      {Array.isArray(input.value)
                        ? `[${input.value.map((x) => number.format(x)).join(", ")}]`
                        : number.format(input.value)}{" "}
                      <span className="text-muted-foreground">
                        from <code>{input.path}</code> in {src?.note ?? input.source} (
                        {(() => {
                          const page = pageFor(src?.path ?? "");
                          return page ? (
                            <a className="underline-offset-2 hover:underline" href={`${base}${page}`}>
                              {src?.path}
                            </a>
                          ) : (
                            <code>{src?.path}</code>
                          );
                        })()}
                        )
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The app page showing a source's records, when there is one: a purchase order's own page, or the
 * module's page for routes whose first segment is (or maps to) an app page. Otherwise no link.
 */
function pageFor(path: string): string | null {
  const order = /^\/purchasing\/orders\/([^/]+)$/.exec(path);
  if (order) return `/purchasing/orders/${order[1]}`;
  const first = path.split("/").filter(Boolean)[0] ?? "";
  const mapped = PAGE_OF_ROUTE[first] ?? (APP_PAGES.has(first) ? first : null);
  return mapped ? `/${mapped}` : null;
}

/** Top-level app pages under a workspace that a source route can open. */
const APP_PAGES = new Set([
  "costing",
  "customers",
  "defence",
  "demand",
  "despatch",
  "haccp",
  "hse",
  "items",
  "npd",
  "production",
  "projects",
  "purchasing",
  "quality",
  "recipes",
  "sales",
  "site",
  "sops",
  "specifications",
  "stock",
  "suppliers",
  "testing",
  "time",
  "training",
]);
/** API route segments whose app page has another name. */
const PAGE_OF_ROUTE: Record<string, string> = {
  labelling: "labels",
  tasks: "my-tasks",
  "time-entries": "time",
};
