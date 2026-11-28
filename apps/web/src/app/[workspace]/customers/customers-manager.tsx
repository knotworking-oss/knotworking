"use client";

import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { Customer } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

export function CustomersManager({ slug, customers }: { slug: string; customers: Customer[] }) {
  const canWrite = useWorkspace().can("customers", "write");
  const [editing, setEditing] = useState<Customer | "new" | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end gap-3">
        {canWrite && <Button onClick={() => setEditing("new")}>New customer</Button>}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Code</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Address</TableHead>
            <TableHead>Contact</TableHead>
            <TableHead>Status</TableHead>
            {canWrite && (
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {customers.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-mono">{c.code}</TableCell>
              <TableCell>
                <p>{c.name}</p>
                <Link className="text-xs underline" href={`/${slug}/customers/${c.id}/sites`}>
                  Delivery sites
                </Link>
              </TableCell>
              <TableCell className="whitespace-pre-line">{c.address}</TableCell>
              <TableCell>{[c.contactName, c.email, c.phone].filter(Boolean).join(" · ") || "—"}</TableCell>
              <TableCell>
                <Badge variant="secondary">{c.status}</Badge>
              </TableCell>
              {canWrite && (
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(c)}
                    aria-label={`Edit ${c.name}`}
                  >
                    Edit
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!customers.length && (
        <p className="py-8 text-center text-sm text-muted-foreground">No customers found.</p>
      )}
      {editing && (
        <CustomerForm
          key={editing === "new" ? "new" : editing.id}
          slug={slug}
          customer={editing === "new" ? null : editing}
          close={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function CustomerForm({ slug, customer, close }: { slug: string; customer: Customer | null; close(): void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    const value = (key: string) => String(f.get(key) ?? "");
    const json = {
      code: value("code"),
      name: value("name"),
      address: value("address"),
      contactName: value("contactName") || null,
      email: value("email") || null,
      phone: value("phone") || null,
      taxNumber: value("taxNumber") || null,
      status: value("status") as "active" | "archived",
    };
    try {
      const api = browserApi().v1.workspaces[":slug"].customers;
      if (customer) await unwrap(api[":id"].$patch({ param: { slug, id: customer.id }, json }));
      else await unwrap(api.$post({ param: { slug }, json }));
      toast.success(customer ? "Customer updated" : "Customer added");
      router.refresh();
      close();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{customer ? "Edit customer" : "New customer"}</DialogTitle>
          <DialogDescription>
            Confirmed delivery records keep their original customer details.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="space-y-1 text-sm">
            Code
            <Input name="code" defaultValue={customer?.code} required maxLength={40} />
          </label>
          <label className="space-y-1 text-sm">
            Business name
            <Input name="name" defaultValue={customer?.name} required maxLength={200} />
          </label>
          <label className="space-y-1 text-sm">
            Business address
            <Textarea name="address" defaultValue={customer?.address} required maxLength={2000} />
          </label>
          <label className="space-y-1 text-sm">
            Contact name
            <Input name="contactName" defaultValue={customer?.contactName ?? ""} maxLength={200} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm">
              Email
              <Input name="email" type="email" defaultValue={customer?.email ?? ""} maxLength={254} />
            </label>
            <label className="space-y-1 text-sm">
              Phone
              <Input name="phone" defaultValue={customer?.phone ?? ""} maxLength={80} />
            </label>
          </div>
          <label className="space-y-1 text-sm">
            Tax number
            <Input name="taxNumber" defaultValue={customer?.taxNumber ?? ""} maxLength={40} />
            <span className="block text-xs text-muted-foreground">
              VAT or other tax registration number, printed on new invoices.
            </span>
          </label>
          <label className="space-y-1 text-sm">
            Status
            <select
              name="status"
              defaultValue={customer?.status ?? "active"}
              className="h-9 w-full rounded-md border bg-background px-3"
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button disabled={busy}>{busy ? "Saving…" : "Save customer"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
