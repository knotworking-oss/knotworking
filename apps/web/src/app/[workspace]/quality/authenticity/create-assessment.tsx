"use client";
import { newId, authenticityDraftSchema } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { browserApi, unwrap, errorMessage } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
export function CreateAuthenticity({
  slug,
  suppliers,
}: {
  slug: string;
  suppliers: { id: string; code: string | null; name: string }[];
}) {
  const { can, viewer } = useWorkspace();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [choices, setChoices] = useState<{ id: string; code: string; name: string }[]>([]);
  const [more, setMore] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [commandId] = useState(newId);
  if (!can("quality", "write")) return null;
  async function search() {
    setError("");
    setBusy(true);
    try {
      const page = await unwrap(
        browserApi().v1.workspaces[":slug"].items.$get({
          param: { slug },
          query: { q, status: "active", limit: "50" },
        }),
      );
      setChoices(page.items);
      setMore(page.total > page.items.length);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      const d = await unwrap(
        browserApi().v1.workspaces[":slug"].quality.authenticity.$post({
          param: { slug },
          json: {
            commandId,
            title: String(f.get("title")),
            itemId: String(f.get("item")),
            supplierId: String(f.get("supplier") ?? "") || null,
            draft: authenticityDraftSchema.parse({ ownerUserId: viewer.id }),
          },
        }),
      );
      router.push(`/${slug}/quality/authenticity/${d.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rounded-md border p-4">
      <summary className="cursor-pointer font-medium">New authenticity assessment</summary>
      <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          Assessment title
          <Input name="title" required maxLength={200} />
        </label>
        <div className="grid gap-2">
          <label className="grid gap-1 text-sm">
            Find material or product
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              maxLength={200}
              placeholder="Item code or name"
            />
          </label>
          <Button type="button" variant="outline" disabled={busy} onClick={search}>
            Find assessment items
          </Button>
          {more && (
            <p className="text-xs text-muted-foreground">
              Showing 50 matches. Refine the item code or name for more.
            </p>
          )}
        </div>
        <div className="grid gap-1 text-sm">
          <label htmlFor="auth-item">Assessed material / product</label>
          <select id="auth-item" name="item" required className="rounded-md border bg-background p-2">
            <option value="">Choose an item</option>
            {choices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.code} · {i.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1 text-sm">
          <label htmlFor="auth-supplier">Supply scope</label>
          <select id="auth-supplier" name="supplier" className="rounded-md border bg-background p-2">
            <option value="">All supply sources for this item</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code ? `${s.code} · ` : ""}
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <p className="text-xs text-muted-foreground">
          One active assessment per item and supplier scope. Supplier approval remains a separate decision.
        </p>
        <Button disabled={busy} className="self-end">
          Create assessment draft
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive sm:col-span-2">
            {error}
          </p>
        )}
      </form>
    </details>
  );
}
