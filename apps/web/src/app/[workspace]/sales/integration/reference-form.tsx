"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { newId, salesExternalSchema, salesExternalTypes } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
export function ReferenceForm({ slug }: { slug: string }) {
  const router = useRouter(),
    { can } = useWorkspace();
  const [commandId, setCommandId] = useState(newId),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = salesExternalSchema.safeParse({ commandId, ...Object.fromEntries(f) });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join("; "));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].sales.integration.references.$post({
          param: { slug },
          json: parsed.data,
        }),
      );
      setCommandId(newId());
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return can("sales", "manage") ? (
    <form
      onSubmit={submit}
      onChange={() => setCommandId(newId())}
      className="space-y-3 rounded-lg border p-4"
    >
      <h2 className="font-medium">Map an external reference</h2>
      <p className="text-sm text-muted-foreground">
        Mapping identifies the same record in another system. It does not transfer ownership or start
        synchronisation.
      </p>
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          System name
          <Input name="system" required maxLength={80} />
        </label>
        <label className="space-y-1 text-sm">
          Record type
          <select name="entityType" className="h-9 w-full rounded-md border bg-background px-3">
            {salesExternalTypes.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          Knotworking record ID
          <Input name="entityId" required />
        </label>
        <label className="space-y-1 text-sm">
          External record ID
          <Input name="externalId" required maxLength={200} />
        </label>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button disabled={busy}>Save mapping</Button>
    </form>
  ) : null;
}
