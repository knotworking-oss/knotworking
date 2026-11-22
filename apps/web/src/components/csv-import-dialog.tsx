"use client";

import { CSV_IMPORT_MAX_CHARS, CSV_IMPORT_MAX_ROWS } from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
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
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/auth-client";

/** What the master-data import routes (items, suppliers, staff) answer with. */
export interface CsvImportResult {
  dryRun: boolean;
  rowCount: number;
  ignoredColumns: string[];
  errors: { row: number; column?: string | undefined; message: string }[];
  created: number;
  updated: number;
  unchanged: number;
  changes: { row: number; action: string; key: string; name: string; fields: string[] }[];
  changesTruncated: boolean;
}

/**
 * Import records from a CSV file: check first (a dry run that lists every problem by row and
 * previews what changes), then import every row in one go. Nothing is written while any row is
 * wrong. Used for items, suppliers and staff; demand has its own dialog.
 */
export function CsvImportDialog({
  id,
  title,
  description,
  columns,
  template,
  templateFileName,
  placeholder,
  noun,
  keyLabel,
  columnLabels,
  run,
  onClose,
}: {
  /** Prefix for element ids. */
  id: string;
  title: string;
  description: ReactNode;
  /** The columns, for the file field's help text. */
  columns: ReactNode;
  template: string;
  templateFileName: string;
  placeholder: string;
  /** "item", "supplier", "person". */
  noun: string;
  /** Heading of the key column in the preview ("Stock code"). */
  keyLabel: string;
  /** Column names in problem lists. */
  columnLabels: Record<string, string>;
  run: (csv: string, fileName: string | null, dryRun: boolean) => Promise<CsvImportResult>;
  onClose: () => void;
}) {
  const router = useRouter();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ csv: string; result: CsvImportResult } | null>(null);
  const [pending, setPending] = useState<"check" | "import" | null>(null);

  const result = checked?.csv === csv ? checked.result : null;
  const ready = result !== null && result.errors.length === 0 && result.rowCount > 0;
  const tooBig = csv.length > CSV_IMPORT_MAX_CHARS;

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setCsv(await file.text());
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([template], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = templateFileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function check() {
    setPending("check");
    try {
      setChecked({ csv, result: await run(csv, fileName, true) });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  async function commit() {
    setPending("import");
    try {
      const done = await run(csv, fileName, false);
      toast.success(
        `Imported ${done.rowCount} ${done.rowCount === 1 ? "row" : "rows"}: ${done.created} new, ${done.updated} changed, ${done.unchanged} unchanged`,
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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <FieldGroup className="py-2">
          <Field>
            <FieldLabel htmlFor={`${id}-file`}>File</FieldLabel>
            <Input
              id={`${id}-file`}
              type="file"
              accept=".csv,.txt,text/csv"
              onChange={(e) => void pickFile(e.target.files?.[0])}
            />
            <FieldDescription>
              {columns} Other columns are ignored. Up to {CSV_IMPORT_MAX_ROWS} rows.{" "}
              <button type="button" className="underline underline-offset-2" onClick={downloadTemplate}>
                Download a template
              </button>
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-text`}>Or paste CSV</FieldLabel>
            <Textarea
              id={`${id}-text`}
              className="h-32 font-mono text-xs"
              placeholder={placeholder}
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setFileName(null);
              }}
            />
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
                <RowErrors errors={result.errors} columnLabels={columnLabels} />
              </>
            ) : (
              <Alert>
                <AlertTitle>
                  {result.rowCount} {result.rowCount === 1 ? "row" : "rows"} ready: {result.created} new,{" "}
                  {result.updated} changed, {result.unchanged} unchanged
                </AlertTitle>
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
                      <TableHead>{keyLabel}</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead className="pr-3">Changes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.changes.map((c) => (
                      <TableRow key={c.row}>
                        <TableCell className="pl-3 tabular-nums">{c.row}</TableCell>
                        <TableCell>{c.action === "create" ? "New" : "Change"}</TableCell>
                        <TableCell className="font-mono text-xs">{c.key}</TableCell>
                        <TableCell>{c.name}</TableCell>
                        <TableCell className="pr-3 whitespace-normal text-muted-foreground">
                          {c.action === "create"
                            ? `New ${noun}`
                            : c.fields.map((f) => columnLabels[f] ?? f).join(", ")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {result.changesTruncated && (
                  <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                    Showing the first {result.changes.length} changes.
                  </p>
                )}
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

/** Problems found in a CSV import, one row each, by spreadsheet row. */
function RowErrors({
  errors,
  columnLabels,
  limit = 100,
}: {
  errors: CsvImportResult["errors"];
  columnLabels: Record<string, string>;
  limit?: number;
}) {
  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16 pl-3">Row</TableHead>
            <TableHead className="w-32">Column</TableHead>
            <TableHead className="pr-3">Problem</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {errors.slice(0, limit).map((e, i) => (
            <TableRow key={`${e.row}-${e.column ?? ""}-${i}`}>
              <TableCell className="pl-3 tabular-nums">{e.row}</TableCell>
              <TableCell className="text-muted-foreground">
                {e.column ? (columnLabels[e.column] ?? e.column) : "—"}
              </TableCell>
              <TableCell className="pr-3 whitespace-normal text-label-red">{e.message}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {errors.length > limit && (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          And {errors.length - limit} more. Fix these and check again.
        </p>
      )}
    </div>
  );
}
