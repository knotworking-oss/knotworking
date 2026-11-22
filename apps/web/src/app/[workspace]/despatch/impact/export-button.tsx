"use client";
import { Button } from "@knotworking/ui/components/button";
import { Spinner } from "@knotworking/ui/components/spinner";
import { useState } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage } from "@/lib/auth-client";

/** A failed or oversized export stays on the report and never downloads an incomplete list. */
export function ImpactExportButton({ slug, lotId, depth }: { slug: string; lotId: string; depth: number }) {
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      const res = await browserApi().v1.workspaces[":slug"].despatch.lots[":lotId"]["impact.csv"].$get({
        param: { slug, lotId },
        query: { depth: String(depth) },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "Could not export the contact list");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `distribution-impact-${lotId}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success("Contact list exported with trace coverage notes");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button variant="outline" disabled={busy} onClick={() => void download()}>
      {busy && <Spinner />} {busy ? "Exporting…" : "Export contact list"}
    </Button>
  );
}
