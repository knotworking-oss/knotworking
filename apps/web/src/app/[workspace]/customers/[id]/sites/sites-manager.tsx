"use client";
import { deliverySiteSchema, type DeliverySite } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { browserApi, unwrap, errorMessage } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
export function SitesManager({
  slug,
  customerId,
  sites,
}: {
  slug: string;
  customerId: string;
  sites: DeliverySite[];
}) {
  const { can } = useWorkspace();
  const [editing, setEditing] = useState<DeliverySite | "new" | null>(null);
  return (
    <>
      <ul className="divide-y rounded-md border">
        {sites.map((s) => (
          <li className="flex flex-wrap items-center justify-between gap-3 p-4" key={s.id}>
            <div>
              <p className="font-medium">
                {s.code} · {s.name} · {s.status}
              </p>
              <p className="text-sm whitespace-pre-line">{s.address}</p>
              <p className="text-sm text-muted-foreground">
                {[s.contactName, s.email, s.phone].filter(Boolean).join(" · ")}
              </p>
            </div>
            {can("customers", "write") && (
              <Button variant="outline" onClick={() => setEditing(s)}>
                Edit {s.code}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {can("customers", "write") && <Button onClick={() => setEditing("new")}>Add delivery site</Button>}
      {editing && (
        <SiteForm
          key={editing === "new" ? "new" : editing.id}
          slug={slug}
          customerId={customerId}
          site={editing === "new" ? undefined : editing}
          done={() => setEditing(null)}
        />
      )}
    </>
  );
}
function SiteForm({
  slug,
  customerId,
  site,
  done,
}: {
  slug: string;
  customerId: string;
  site?: DeliverySite;
  done: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? "").trim();
    try {
      const json = deliverySiteSchema.parse({
        code: text("code"),
        name: text("name"),
        address: text("address"),
        contactName: text("contactName") || null,
        email: text("email") || null,
        phone: text("phone") || null,
        status: text("status"),
      });
      const api = browserApi().v1.workspaces[":slug"].customers[":id"].sites;
      if (site) await unwrap(api[":siteId"].$put({ param: { slug, id: customerId, siteId: site.id }, json }));
      else await unwrap(api.$post({ param: { slug, id: customerId }, json }));
      done();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="grid gap-3 rounded-md border p-4 sm:grid-cols-2" onSubmit={submit}>
      <h2 className="font-medium sm:col-span-2">{site ? "Edit delivery site" : "New delivery site"}</h2>
      {(
        [
          ["code", "Site code"],
          ["name", "Site name"],
          ["contactName", "Contact name"],
          ["email", "Contact email"],
          ["phone", "Contact phone"],
        ] as const
      ).map(([key, label]) => (
        <label className="grid gap-1 text-sm" key={key}>
          {label}
          <Input
            name={key}
            type={key === "email" ? "email" : "text"}
            required={key === "code" || key === "name"}
            defaultValue={site?.[key] ?? ""}
            maxLength={key === "code" ? 40 : key === "phone" ? 100 : key === "email" ? 320 : 200}
          />
        </label>
      ))}
      <label className="grid gap-1 text-sm">
        Delivery address
        <Textarea name="address" required defaultValue={site?.address ?? ""} maxLength={2000} />
      </label>
      <div className="grid gap-1 text-sm">
        <label htmlFor="site-status">Site status</label>
        <select
          id="site-status"
          name="status"
          defaultValue={site?.status ?? "active"}
          className="rounded-md border bg-background p-2"
        >
          <option>active</option>
          <option>archived</option>
        </select>
      </div>
      <div className="flex items-end gap-2">
        <Button disabled={busy}>Save delivery site</Button>
        <Button type="button" variant="outline" onClick={done}>
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive sm:col-span-2">
          {error}
        </p>
      )}
    </form>
  );
}
