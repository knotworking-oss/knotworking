"use client";

import { todayInZone } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { csvDocument, csvFileName, type CsvRows } from "@/lib/csv-export";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

/**
 * Downloads a CSV made in the browser: from rows the page already holds, or from `rows()` when
 * the list is paged and the button fetches every page first. Text cells are quoted and checked
 * for spreadsheet formulas by `toCsv`.
 */
export function ExportCsvButton({
  name,
  rows,
  label = "Export CSV",
  size = "sm",
}: {
  /** What the file is about: "Complaints" becomes `complaints-2026-11-13.csv`. */
  name: string;
  rows: CsvRows | (() => Promise<CsvRows>);
  label?: string;
  size?: "sm" | "default";
}) {
  const [busy, setBusy] = useState(false);
  const timeZone = useWorkspaceTimeZone();

  async function download() {
    setBusy(true);
    try {
      const data = typeof rows === "function" ? await rows() : rows;
      const blob = new Blob([csvDocument(data)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = csvFileName(name, todayInZone(timeZone)); // the workspace's today, not UTC's
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success(`${Math.max(0, data.length - 1)} rows exported`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not export");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="outline" size={size} disabled={busy} onClick={() => void download()}>
      {busy ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" />} {label}
    </Button>
  );
}
