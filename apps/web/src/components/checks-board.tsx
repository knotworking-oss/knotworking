"use client";

import {
  checkItemResultLabels,
  checkItemResults,
  checklistKindLabels,
  siteChecklistKinds,
  type CheckItemResult,
  type ChecklistKind,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { ClipboardCheck, Plus, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { DueStateBadge } from "@/components/haccp-badges";
import { OutcomeBadge, SignOffBadge } from "@/components/site-badges";
import {
  FrequencyField,
  NONE,
  SelectField,
  SiteDialog,
  TextAreaField,
  TextField,
  useDateTime,
  frequencyBody,
  siteApi,
  checklistApi,
  text,
  type FrequencyState,
} from "@/components/site-forms";
import { CorrectCheckDialog } from "@/components/site-correct-dialogs";
import type { ChecklistCheck, ChecklistTemplate, SiteArea } from "@/lib/api";
import { unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

type BatchOption = { id: string; label: string };
type Dialog =
  | { kind: "template"; template?: ChecklistTemplate }
  | { kind: "check"; template: ChecklistTemplate }
  | { kind: "signoff"; check: ChecklistCheck }
  | { kind: "correct"; check: ChecklistCheck };

/**
 * Pre-start and allergen changeover checks: checklists per line or area, completed checks with a
 * result per item, and a sign-off by a person with manage access before production starts. A
 * check with a failed item can only be held; it is done again once the failure is put right.
 */
export function ChecksBoard({
  slug,
  templates,
  checks,
  areas,
  batches,
  general = false,
  withProduction = false,
}: {
  slug: string;
  general?: boolean;
  withProduction?: boolean;
  templates: ChecklistTemplate[];
  checks: ChecklistCheck[];
  areas: SiteArea[];
  batches: BatchOption[];
}) {
  const dateTime = useDateTime();
  const { can } = useWorkspace();
  const canWrite = can("checklists", "write") && (general || can("site", "write"));
  const canManage = !general && canWrite && can("site", "manage");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const live = general ? templates : templates.filter((t) => t.status === "active");

  return (
    <div className="workspace-content flex flex-col gap-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">
          {general ? "Checklists" : "Pre-start and changeover checks"}
        </h2>
        {canWrite && (
          <Button onClick={() => setDialog({ kind: "template" })}>
            <Plus data-icon="inline-start" /> Add checklist
          </Button>
        )}
      </div>

      <Card className="py-0">
        <CardContent className="overflow-x-auto px-0 py-2">
          {live.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">No checklists yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Checklist</TableHead>
                  {!general && <TableHead>Kind</TableHead>}
                  <TableHead>Where</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Next</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {live.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="pl-4 font-medium">
                      {t.name}
                      {t.status === "archived" && (
                        <span className="block text-xs text-muted-foreground">Archived</span>
                      )}
                    </TableCell>
                    {!general && <TableCell>{checklistKindLabels[t.kind]}</TableCell>}
                    <TableCell>{t.line ?? t.area?.name ?? "—"}</TableCell>
                    <TableCell>{t.items.length}</TableCell>
                    <TableCell>
                      {t.due ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <DueStateBadge state={t.due.state} />
                          <span className="text-xs text-muted-foreground">{t.frequencyText}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">When needed</span>
                      )}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {canWrite && general && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: "template", template: t })}
                        >
                          Edit
                        </Button>
                      )}
                      {canWrite && t.status === "active" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDialog({ kind: "check", template: t })}
                        >
                          <ClipboardCheck data-icon="inline-start" /> Complete
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card id="completed-checks" className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>Completed checks</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          {checks.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No checks yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">When</TableHead>
                  <TableHead>Checklist</TableHead>
                  <TableHead>Result</TableHead>
                  {!general && <TableHead>Sign-off</TableHead>}
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {checks.map((c) => (
                  <TableRow key={c.id} className="align-top">
                    <TableCell className="pl-4 whitespace-nowrap">
                      {dateTime(c.performedAt)}
                      <div className="text-xs text-muted-foreground">{c.performedByName}</div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="font-medium">{c.templateName}</div>
                      {(c.previousBatch || c.nextBatch) && (
                        <div className="text-xs text-muted-foreground">
                          {c.previousBatch?.batchCode ?? "?"} → {c.nextBatch?.batchCode ?? "?"}
                        </div>
                      )}
                      {c.allergenRisk && c.allergenRisk.status === "review" && (
                        <AllergenRiskNote warnings={c.allergenRisk.warnings} />
                      )}
                      {general && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground">Item results</summary>
                          <ul className="mt-1 space-y-1">
                            {c.results.map((r) => (
                              <li key={r.id}>
                                {r.prompt} · {checkItemResultLabels[r.result]}
                                {r.note ? ` · ${r.note}` : ""}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {!general &&
                        c.results
                          .filter((r) => r.result === "fail")
                          .map((r) => (
                            <div key={r.id} className="text-xs text-destructive">
                              {r.prompt}: {r.note}
                            </div>
                          ))}
                    </TableCell>
                    <TableCell>
                      <OutcomeBadge outcome={c.outcome} />
                    </TableCell>
                    {!general && (
                      <TableCell className="whitespace-normal">
                        <SignOffBadge status={c.signOffStatus} />
                        {c.signedOffByName && (
                          <div className="text-xs text-muted-foreground">{c.signedOffByName}</div>
                        )}
                      </TableCell>
                    )}
                    <TableCell className="pr-4 text-right">
                      {canWrite && !c.correctedByCheckId && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: "correct", check: c })}
                        >
                          Correct
                        </Button>
                      )}
                      {c.awaitingSignOff && canManage && c.areaHold && (
                        <span className="text-xs text-destructive">
                          Area on hold after a glass breakage ({c.areaHold.description}). Release it on the
                          glass page before signing off.
                        </span>
                      )}
                      {c.awaitingSignOff && canManage && !c.areaHold && (
                        <Button size="sm" onClick={() => setDialog({ kind: "signoff", check: c })}>
                          <ShieldCheck data-icon="inline-start" /> Sign off
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {dialog?.kind === "template" && (
        <TemplateDialog
          slug={slug}
          areas={areas}
          general={general}
          withProduction={withProduction}
          template={dialog.template}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "check" && (
        <CheckDialog
          slug={slug}
          template={dialog.template}
          batches={batches}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "correct" && (
        <CorrectCheckDialog slug={slug} check={dialog.check} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "signoff" && (
        <SignOffDialog slug={slug} check={dialog.check} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

/** The allergens the batch before leaves behind: a warning for whoever records or signs off. */
function AllergenRiskNote({ warnings }: { warnings: string[] }) {
  return (
    <div className="mt-1 flex flex-col gap-1 rounded-md border border-status-started/50 bg-status-started/10 p-2 text-xs">
      <span className="flex items-center gap-1 font-medium">
        <TriangleAlert className="size-3" /> Allergen risk
      </span>
      {warnings.map((w) => (
        <span key={w}>{w}</span>
      ))}
    </div>
  );
}

function TemplateDialog({
  slug,
  areas,
  general,
  withProduction,
  template,
  onClose,
}: {
  slug: string;
  areas: SiteArea[];
  general: boolean;
  withProduction: boolean;
  template?: ChecklistTemplate | undefined;
  onClose: () => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [kind, setKind] = useState<ChecklistKind>("prestart");
  const [area, setArea] = useState(NONE);
  const [line, setLine] = useState(template?.line ?? "");
  const [scheduled, setScheduled] = useState(template ? !!template.frequency : true);
  const [frequency, setFrequency] = useState<FrequencyState>({
    every: String(template?.frequency?.every ?? 1),
    unit: template?.frequency?.unit ?? "day",
  });
  const [status, setStatus] = useState<"active" | "archived">(template?.status ?? "active");
  const [during, setDuring] = useState(false);
  const [items, setItems] = useState(template?.items.map((item) => item.prompt).join("\n") ?? "");
  const prompts = items
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    <SiteDialog
      title={template ? "Edit checklist" : "Add checklist"}
      description="One item per line. Checks done against it keep the wording they were done with."
      submitLabel={template ? "Save checklist" : "Add checklist"}
      disabled={prompts.length === 0}
      onClose={onClose}
      onSubmit={async () => {
        if (general) {
          const previousItems = new Map(template?.items.map((item) => [item.prompt.toLowerCase(), item]));
          const json = {
            name: name.trim(),
            line: text(line) ?? null,
            frequency: scheduled ? frequencyBody(frequency) : null,
            items: prompts.map((prompt) => {
              const previous = previousItems.get(prompt.toLowerCase());
              return previous ? { id: previous.id, prompt, guidance: previous.guidance } : { prompt };
            }),
          };
          await unwrap(
            template
              ? checklistApi().templates[":id"].$patch({
                  param: { slug, id: template.id },
                  json: { ...json, status },
                })
              : checklistApi().templates.$post({ param: { slug }, json }),
          );
          return template ? "Checklist saved" : "Checklist added";
        }
        await unwrap(
          siteApi().checklists.templates.$post({
            param: { slug },
            json: {
              name: name.trim(),
              kind,
              ...(area !== NONE ? { areaId: area } : {}),
              ...(text(line) ? { line: text(line)! } : {}),
              ...(scheduled ? { frequency: frequencyBody(frequency), duringProduction: during } : {}),
              items: prompts.map((prompt) => ({ prompt })),
            },
          }),
        );
        return `${name.trim()} added`;
      }}
    >
      <TextField id="ct-name" label="Name" required value={name} onChange={setName} />
      {!general && (
        <>
          <SelectField
            id="ct-kind"
            label="Kind"
            value={kind}
            onChange={(v) => setKind(v as ChecklistKind)}
            options={siteChecklistKinds.map((k) => [k, checklistKindLabels[k]] as const)}
          />
          <SelectField
            id="ct-area"
            label="Area"
            value={area}
            onChange={setArea}
            options={[[NONE, "No area"], ...areas.map((a) => [a.id, a.name] as const)]}
          />
        </>
      )}
      <TextField id="ct-line" label={general ? "Location" : "Line"} value={line} onChange={setLine} />
      {template && (
        <SelectField
          id="ct-status"
          label="Status"
          value={status}
          onChange={(v) => setStatus(v as typeof status)}
          options={[
            ["active", "Active"],
            ["archived", "Archived"],
          ]}
        />
      )}
      <Field orientation="horizontal">
        <Checkbox id="ct-sched" checked={scheduled} onCheckedChange={(v) => setScheduled(v === true)} />
        <FieldLabel htmlFor="ct-sched">On a schedule (otherwise it is done when needed)</FieldLabel>
      </Field>
      {scheduled && (
        <>
          <FrequencyField id="ct-freq" label="Needed every" value={frequency} onChange={setFrequency} />
          {withProduction && (
            <Field orientation="horizontal">
              <Checkbox id="ct-during" checked={during} onCheckedChange={(v) => setDuring(v === true)} />
              <FieldLabel htmlFor="ct-during">Only while something is in production</FieldLabel>
            </Field>
          )}
        </>
      )}
      <TextAreaField id="ct-items" label="Items" required rows={6} value={items} onChange={setItems} />
    </SiteDialog>
  );
}

function CheckDialog({
  slug,
  template,
  batches,
  onClose,
}: {
  slug: string;
  template: ChecklistTemplate;
  batches: BatchOption[];
  onClose: () => void;
}) {
  const [results, setResults] = useState<Record<string, { result: CheckItemResult; note: string }>>({});
  const [note, setNote] = useState("");
  const [previous, setPrevious] = useState(NONE);
  const [next, setNext] = useState(NONE);
  const [risk, setRisk] = useState<{ status: string; warnings: string[] } | null>(null);
  useEffect(() => {
    if (template.kind !== "allergen_changeover" || (previous === NONE && next === NONE)) {
      setRisk(null);
      return;
    }
    let live = true;
    siteApi()
      .checklists["allergen-risk"].$get({
        param: { slug },
        query: {
          ...(previous !== NONE ? { previousBatchId: previous } : {}),
          ...(next !== NONE ? { nextBatchId: next } : {}),
        },
      })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => live && setRisk(body))
      .catch(() => live && setRisk(null));
    return () => {
      live = false;
    };
  }, [slug, template.kind, previous, next]);
  const of = (id: string) => results[id] ?? { result: "pass" as CheckItemResult, note: "" };
  const general = template.kind === "general";
  const missingResult = general && template.items.some((item) => !results[item.id]);
  const changeover = template.kind === "allergen_changeover" && batches.length > 0;
  const batchOptions = [[NONE, "Not recorded"], ...batches.map((b) => [b.id, b.label] as const)] as const;
  return (
    <SiteDialog
      wide
      title={template.name}
      description="Record a result for every item. A failed item needs a note of what was found and done."
      submitLabel="Record check"
      onClose={onClose}
      disabled={missingResult}
      onSubmit={async () => {
        if (missingResult) throw new Error("Select a result for every item");
        const json = {
          templateId: template.id,
          results: template.items.map((i) => ({
            itemId: i.id,
            result: of(i.id).result,
            note: text(of(i.id).note),
          })),
          note: text(note),
        };
        if (general) {
          const recorded = await unwrap(checklistApi().checks.$post({ param: { slug }, json }));
          return recorded.outcome === "failed" ? "Check recorded and follow-up opened" : "Check recorded";
        }
        await unwrap(
          siteApi().checklists.checks.$post({
            param: { slug },
            json: {
              ...json,
              ...(changeover && previous !== NONE ? { previousBatchId: previous } : {}),
              ...(changeover && next !== NONE ? { nextBatchId: next } : {}),
            },
          }),
        );
        return "Check recorded and awaiting sign-off";
      }}
    >
      {changeover && (
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="ck-prev"
            label="Batch before"
            value={previous}
            onChange={setPrevious}
            options={batchOptions}
          />
          <SelectField
            id="ck-next"
            label="Batch after"
            value={next}
            onChange={setNext}
            options={batchOptions}
          />
        </div>
      )}
      {changeover && risk && risk.status !== "none" && <AllergenRiskNote warnings={risk.warnings} />}
      {template.items.map((i) => (
        <div key={i.id} className="grid gap-2 rounded-md border p-3 sm:grid-cols-5">
          <div className="sm:col-span-2">
            <div className="text-sm font-medium">{i.prompt}</div>
            {i.guidance && <div className="text-xs text-muted-foreground">{i.guidance}</div>}
          </div>
          <SelectField
            id={`ck-${i.id}`}
            label="Result"
            value={general && !results[i.id] ? NONE : of(i.id).result}
            onChange={(v) =>
              v !== NONE &&
              setResults((r) => ({ ...r, [i.id]: { ...of(i.id), result: v as CheckItemResult } }))
            }
            options={[
              ...(general ? [[NONE, "Select a result"] as const] : []),
              ...checkItemResults.map((r) => [r, checkItemResultLabels[r]] as const),
            ]}
          />
          <TextField
            id={`ck-note-${i.id}`}
            label="Note"
            required={of(i.id).result === "fail"}
            value={of(i.id).note}
            onChange={(v) => setResults((r) => ({ ...r, [i.id]: { ...of(i.id), note: v } }))}
            className="sm:col-span-2"
          />
        </div>
      ))}
      <TextField id="ck-note" label="Overall note" value={note} onChange={setNote} />
    </SiteDialog>
  );
}

function SignOffDialog({
  slug,
  check,
  onClose,
}: {
  slug: string;
  check: ChecklistCheck;
  onClose: () => void;
}) {
  const dateTime = useDateTime();
  const [decision, setDecision] = useState<"approve" | "reject">(
    check.outcome === "failed" ? "reject" : "approve",
  );
  const [note, setNote] = useState("");
  return (
    <SiteDialog
      title="Sign off before production"
      description={`${check.templateName}, ${dateTime(check.performedAt)}. Signing off says production may start; holding it says it may not. This is your sign-off.`}
      submitLabel={decision === "approve" ? "Sign off" : "Hold production"}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().checklists.checks[":id"]["sign-off"].$post({
            param: { slug, id: check.id },
            json: { decision, ...(text(note) ? { note: text(note)! } : {}) },
          }),
        );
        return decision === "approve" ? "Signed off" : "Production held";
      }}
    >
      {check.outcome === "failed" && (
        <p className="text-sm text-destructive">Items failed on this check, so it can only be held.</p>
      )}
      <SelectField
        id="so-decision"
        label="Decision"
        value={decision}
        onChange={(v) => setDecision(v as "approve" | "reject")}
        options={[
          ["approve", "Sign off: production may start"],
          ["reject", "Hold: production may not start"],
        ]}
        disabled={check.outcome === "failed"}
      />
      <TextAreaField
        id="so-note"
        label="Note"
        required={decision === "reject"}
        value={note}
        onChange={setNote}
      />
    </SiteDialog>
  );
}
