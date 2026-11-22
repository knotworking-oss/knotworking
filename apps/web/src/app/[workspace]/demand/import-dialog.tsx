"use client";

import { DEMAND_CSV_TEMPLATE, DEMAND_IMPORT_MAX_CHARS, DEMAND_IMPORT_MAX_ROWS } from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Spinner } from "@knotworking/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DemandRowErrors } from "@/components/demand-badges";
import { formatAmount } from "@/components/stock-badges";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

type ImportResult = Awaited<ReturnType<typeof runImport>>;

const runImport = (
  slug: string,
  csv: string,
  fileName: string | null,
  dryRun: boolean,
  replaceHorizon: boolean,
) =>
  unwrap(
    browserApi().v1.workspaces[":slug"].demand.imports.$post({
      param: { slug },
      json: { csv, dryRun, ...(fileName ? { fileName } : {}), ...(replaceHorizon ? { replaceHorizon } : {}) },
    }),
  );

const actionLabels = { create: "New", update: "Change", remove: "Remove" } as const;

/**
 * Import demand from a CSV file: check first (a dry run that lists every problem by row and
 * previews what changes), then import every row in one go. Nothing is written while any row is
 * wrong.
 */
export function ImportDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const router = useRouter();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [replaceHorizon, setReplaceHorizon] = useState(false);
  const [checked, setChecked] = useState<{ csv: string; replace: boolean; result: ImportResult } | null>(
    null,
  );
  const [pending, setPending] = useState<"check" | "import" | null>(null);

  const result = checked?.csv === csv && checked.replace === replaceHorizon ? checked.result : null;
  const ready = result !== null && result.errors.length === 0 && result.rowCount > 0;
  const tooBig = csv.length > DEMAND_IMPORT_MAX_CHARS;

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setCsv(await file.text());
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([DEMAND_CSV_TEMPLATE], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "demand-template.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function check() {
    setPending("check");
    try {
      setChecked({
        csv,
        replace: replaceHorizon,
        result: await runImport(slug, csv, fileName, true, replaceHorizon),
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  async function commit() {
    setPending("import");
    try {
      const done = await runImport(slug, csv, fileName, false, replaceHorizon);
      toast.success(
        `Imported ${done.rowCount} ${done.rowCount === 1 ? "row" : "rows"}: ${done.created} new, ${done.updated} changed, ${done.unchanged} unchanged${done.horizon ? `, ${done.removed} removed` : ""}`,
      );
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import demand from CSV</DialogTitle>
          <DialogDescription>
            One row per product, week and customer. A row for a product, week and customer that already has
            demand replaces its quantity.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="py-2">
          <Field>
            <FieldLabel htmlFor="demand-csv-file">File</FieldLabel>
            <Input
              id="demand-csv-file"
              type="file"
              accept=".csv,.txt,text/csv"
              onChange={(e) => void pickFile(e.target.files?.[0])}
            />
            <FieldDescription>
              Columns: <code>item</code> (stock code), <code>period</code> (a date such as 09/11/2026 or
              2026-11-09, or a week such as 2026-W46), <code>quantity</code>; optional <code>unit</code>{" "}
              (default: the product&apos;s unit), <code>customer</code>, <code>note</code>,{" "}
              <code>reference</code>. Other columns are ignored. Up to {DEMAND_IMPORT_MAX_ROWS} rows.{" "}
              <button type="button" className="underline underline-offset-2" onClick={downloadTemplate}>
                Download a template
              </button>
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="demand-csv-text">Or paste CSV</FieldLabel>
            <Textarea
              id="demand-csv-text"
              className="h-32 font-mono text-xs"
              placeholder={"item,period,quantity,customer\nCAKE-1,2026-W46,120,Tesco"}
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setFileName(null);
              }}
            />
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              id="demand-replace-horizon"
              checked={replaceHorizon}
              onCheckedChange={(v) => setReplaceHorizon(v === true)}
            />
            <div className="flex flex-col gap-1">
              <FieldLabel htmlFor="demand-replace-horizon">Replace this horizon</FieldLabel>
              <FieldDescription>
                Also remove demand for the file&apos;s customers, any product, in the weeks from its first to
                its last that the file doesn&apos;t have. Other customers&apos; demand is left alone. Removed
                lines stay in each line&apos;s history. Check the file to see what will go.
              </FieldDescription>
            </div>
          </Field>
        </FieldGroup>

        {tooBig && (
          <Alert variant="destructive">
            <AlertTitle>The file is too large</AlertTitle>
            <AlertDescription>Split it into smaller files.</AlertDescription>
          </Alert>
        )}

        {result && (
          <div className="flex flex-col gap-3">
            {result.errors.length > 0 ? (
              <>
                <Alert variant="destructive">
                  <AlertTitle>
                    {new Set(result.errors.map((e) => e.row)).size} of {result.rowCount}{" "}
                    {result.rowCount === 1 ? "row has" : "rows have"} problems
                  </AlertTitle>
                  <AlertDescription>Nothing will be imported until every row is right.</AlertDescription>
                </Alert>
                <DemandRowErrors errors={result.errors} />
              </>
            ) : (
              <Alert>
                <AlertTitle>
                  {result.rowCount} {result.rowCount === 1 ? "row" : "rows"} ready: {result.created} new,{" "}
                  {result.updated} changed, {result.unchanged} unchanged
                  {result.horizon && `, ${result.removed} to remove`}
                </AlertTitle>
                {result.horizon && (
                  <AlertDescription>
                    Replacing {result.horizon.fromWeek} to {result.horizon.toWeek}: demand in these weeks that
                    is not in the file is removed.
                  </AlertDescription>
                )}
                {result.ignoredColumns.length > 0 && (
                  <AlertDescription>Ignored columns: {result.ignoredColumns.join(", ")}</AlertDescription>
                )}
              </Alert>
            )}
            {result.changes.length > 0 && (
              <div className="max-h-64 overflow-y-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-14 pl-3">Row</TableHead>
                      <TableHead>Change</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Week</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead className="text-right">Was</TableHead>
                      <TableHead className="pr-3 text-right">Becomes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...result.changes]
                      .sort((a, b) => Number(b.action === "remove") - Number(a.action === "remove"))
                      .slice(0, 200)
                      .map((c, i) => (
                        <TableRow key={i} className={c.action === "remove" ? "text-destructive" : undefined}>
                          <TableCell className="pl-3 tabular-nums">{c.row || "—"}</TableCell>
                          <TableCell>
                            {actionLabels[c.action as keyof typeof actionLabels] ?? c.action}
                          </TableCell>
                          <TableCell>
                            <span className="font-mono text-xs">{c.item.code}</span> {c.item.name}
                          </TableCell>
                          <TableCell className="tabular-nums">{c.week}</TableCell>
                          <TableCell className={c.customer ? "" : "text-muted-foreground"}>
                            {c.customer ?? "Any"}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground tabular-nums">
                            {c.previous ? formatAmount(c.previous) : "—"}
                          </TableCell>
                          <TableCell className="pr-3 text-right tabular-nums">
                            {c.amount ? formatAmount(c.amount) : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant={ready ? "outline" : "default"}
            disabled={pending !== null || !csv.trim() || tooBig}
            onClick={() => void check()}
          >
            {pending === "check" && <Spinner data-icon="inline-start" />} Check file
          </Button>
          <Button type="button" disabled={pending !== null || !ready} onClick={() => void commit()}>
            {pending === "import" && <Spinner data-icon="inline-start" />} Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
