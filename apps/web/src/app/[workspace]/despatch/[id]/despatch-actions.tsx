"use client";
import { loadCheckPassed, newId } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Textarea } from "@knotworking/ui/components/textarea";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { Despatch } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

export function DespatchActions({ slug, despatch }: { slug: string; despatch: Despatch }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [confirmId] = useState(newId);
  const [voidId] = useState(newId);
  const [dialog, setDialog] = useState<"confirm" | "void" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const api = browserApi().v1.workspaces[":slug"].despatch[":id"];
    try {
      if (dialog === "confirm")
        await unwrap(
          api.confirm.$post({
            param: { slug, id: despatch.id },
            json: { commandId: confirmId, expectedUpdatedAt: despatch.updatedAt },
          }),
        );
      else
        await unwrap(
          api.void.$post({
            param: { slug, id: despatch.id },
            json: { commandId: voidId, reason: String(new FormData(e.currentTarget).get("reason")) },
          }),
        );
      toast.success(dialog === "confirm" ? "Despatch confirmed" : "Despatch voided");
      setDialog(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button asChild variant="outline">
        <Link href={`/${slug}/despatch/${despatch.id}/print`}>Print delivery note</Link>
      </Button>
      {despatch.status === "draft" && !despatch.allocatedAt && can("despatch", "write") && (
        <Button asChild variant="outline">
          <Link href={`/${slug}/despatch/${despatch.id}/edit`}>Edit draft</Link>
        </Button>
      )}
      {despatch.status === "draft" &&
        !!despatch.packedAt &&
        !!despatch.loadCheck &&
        loadCheckPassed(despatch.loadCheck) &&
        can("despatch", "manage") && (
          <Button
            onClick={() => {
              setError("");
              setDialog("confirm");
            }}
          >
            Confirm despatch
          </Button>
        )}
      {despatch.status !== "voided" && can("despatch", "manage") && (
        <Button
          variant="outline"
          onClick={() => {
            setError("");
            setDialog("void");
          }}
        >
          Void {despatch.status === "draft" ? "draft" : "record"}
        </Button>
      )}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog === "confirm" ? "Confirm physical despatch" : "Void this record"}
            </DialogTitle>
            <DialogDescription>
              {dialog === "confirm"
                ? "Confirm that these lots and quantities have left for this customer. Stock will be withdrawn and the delivery record retained."
                : "Void only a recording mistake. A confirmed despatch's stock is restored. Goods physically returned by a customer must be handled separately and quarantined."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={act} className="space-y-4">
            {dialog === "void" && (
              <label className="block space-y-1 text-sm">
                Reason
                <Textarea name="reason" required maxLength={2000} disabled={busy} />
              </label>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {error && dialog === "confirm" && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setDialog(null);
                  router.refresh();
                }}
              >
                Reload record
              </Button>
            )}
            <Button disabled={busy}>
              {busy ? "Saving…" : dialog === "confirm" ? "Confirm despatch" : "Void record"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
