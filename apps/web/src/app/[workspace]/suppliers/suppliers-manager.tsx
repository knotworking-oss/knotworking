"use client";

import { RecordAttachments } from "@/components/record-attachments";
import { useWorkspaceToday } from "@/lib/workspace-time";
import {
  SUPPLIER_CSV_TEMPLATE,
  supplierApprovalLabels,
  supplierApprovalStatuses,
  type SupplierApprovalStatus,
  supplierCategories,
  supplierCategoryLabels,
  supplierRiskLevelLabels,
  type SupplierCategory,
  type SupplierControlEnforcement,
  type SupplierRiskLevel,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
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
import { FileUp, Plus, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CsvImportDialog } from "@/components/csv-import-dialog";
import { SupplierApprovalBadge } from "@/components/item-badges";
import type { Supplier } from "@/lib/api";
import { ApiError, browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

const day = (value: string | null) => (value ? formatLongDate(value) : "—");

/** Suppliers → the list, the create/edit dialog and the approval sign-off. */
export function SuppliersManager({
  slug,
  suppliers,
  compliance,
  enforcement,
}: {
  slug: string;
  suppliers: Supplier[];
  /** Each supplier's risk level and open control issues (by supplier id). */
  compliance: Record<string, { riskLevel: SupplierRiskLevel | null; actionCount: number }>;
  /** Whether open control issues only show or also block approval and orders. */
  enforcement: SupplierControlEnforcement;
}) {
  const { can } = useWorkspace();
  const today = useWorkspaceToday();
  const isPast = (value: string | null) => Boolean(value && value < today);
  const canWrite = can("items", "write");
  const canApprove = can("items", "manage");
  const [editing, setEditing] = useState<Supplier | "new" | null>(null);
  const [approving, setApproving] = useState<Supplier | null>(null);
  const [importing, setImporting] = useState(false);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Suppliers</h2>
        <EnforcementSetting slug={slug} enforcement={enforcement} canChange={canApprove} />
        {canWrite && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setImporting(true)}>
              <FileUp data-icon="inline-start" /> Import CSV
            </Button>
            <Button onClick={() => setEditing("new")}>
              <Plus data-icon="inline-start" /> New supplier
            </Button>
          </div>
        )}
      </div>

      {suppliers.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No suppliers yet.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Supplier</TableHead>
                <TableHead>Approval</TableHead>
                <TableHead>Review due</TableHead>
                <TableHead>Certification</TableHead>
                <TableHead>Certificate expires</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Controls</TableHead>
                <TableHead className="pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {suppliers.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="pl-4">
                    <Link href={`/${slug}/suppliers/${s.id}`} className="font-medium hover:underline">
                      {s.name}
                    </Link>
                    {s.code && <span className="ml-2 font-mono text-xs text-muted-foreground">{s.code}</span>}
                    {s.category === "service" && (
                      <div className="text-xs text-muted-foreground">
                        {s.serviceType ?? "Service provider"}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <SupplierApprovalBadge status={s.approvalStatus} />
                  </TableCell>
                  <TableCell className={isPast(s.reviewDueOn) ? "text-destructive" : undefined}>
                    {day(s.reviewDueOn)}
                  </TableCell>
                  <TableCell>{s.certification ?? "—"}</TableCell>
                  <TableCell className={isPast(s.certificateExpiresOn) ? "text-destructive" : undefined}>
                    {day(s.certificateExpiresOn)}
                  </TableCell>
                  <TableCell>{s.itemCount}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {compliance[s.id]?.riskLevel && (
                        <Badge variant="outline">
                          {supplierRiskLevelLabels[compliance[s.id]!.riskLevel!]} risk
                        </Badge>
                      )}
                      {(compliance[s.id]?.actionCount ?? 0) > 0 ? (
                        <Badge variant="destructive">{compliance[s.id]!.actionCount} to act on</Badge>
                      ) : (
                        compliance[s.id] && <Badge variant="secondary">In order</Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    {canWrite && (
                      <Button variant="ghost" size="sm" onClick={() => setEditing(s)}>
                        Edit
                      </Button>
                    )}
                    {canApprove && (
                      <Button variant="outline" size="sm" onClick={() => setApproving(s)}>
                        <ShieldCheck data-icon="inline-start" /> Approval
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {editing && (
        <SupplierDialog
          key={editing === "new" ? "new" : editing.id}
          slug={slug}
          supplier={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {approving && (
        <ApprovalDialog
          key={approving.id}
          slug={slug}
          supplier={approving}
          onClose={() => setApproving(null)}
        />
      )}
      {importing && <SuppliersImportDialog slug={slug} onClose={() => setImporting(false)} />}
    </div>
  );
}

const supplierImportLabels = {
  code: "Code",
  name: "Name",
  contactName: "Contact name",
  email: "Email",
  phone: "Phone",
  address: "Address",
  notes: "Notes",
  certification: "Certification",
  certificateExpiresOn: "Certificate expiry",
};

/** Create and update suppliers from a CSV file, matched by code or name. Never approves. */
/** Whether open supplier control issues block approval and orders: Items managers change it. */
function EnforcementSetting({
  slug,
  enforcement,
  canChange,
}: {
  slug: string;
  enforcement: SupplierControlEnforcement;
  canChange: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function change(value: SupplierControlEnforcement) {
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].suppliers["control-settings"].$put({
          param: { slug },
          json: { enforcement: value },
        }),
      );
      toast.success(
        value === "block"
          ? "Open control issues now block approval and orders"
          : "Open control issues are reported only",
      );
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Field orientation="horizontal" className="w-auto">
      <FieldLabel id="enforcement-label" className="whitespace-nowrap text-muted-foreground">
        Open control issues
      </FieldLabel>
      <Select
        value={enforcement}
        disabled={!canChange || pending}
        onValueChange={(v) => void change(v as SupplierControlEnforcement)}
      >
        <SelectTrigger aria-labelledby="enforcement-label" className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="report">Report only</SelectItem>
            <SelectItem value="block">Block approval and orders</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function SuppliersImportDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  return (
    <CsvImportDialog
      id="suppliers-csv"
      title="Import suppliers from CSV"
      description="One row per supplier, matched by code (or by name when the row has no code). New suppliers start as pending approval; an import never approves or changes an approval."
      columns={
        <>
          Columns: <code>code</code> and/or <code>name</code> (new suppliers need a name); optional{" "}
          <code>contact name</code>, <code>email</code>, <code>phone</code>, <code>address</code>,{" "}
          <code>notes</code>, <code>certification</code>, <code>certificate expiry</code> (2027-03-31 or
          31/03/2027). A column you leave out keeps what suppliers have; an empty cell clears it.
        </>
      }
      template={SUPPLIER_CSV_TEMPLATE}
      templateFileName="suppliers-template.csv"
      placeholder={"code,name,email\nMILL01,Eastern Mills Ltd,orders@easternmills.example"}
      noun="supplier"
      keyLabel="Code or name"
      columnLabels={supplierImportLabels}
      run={(csv, fileName, dryRun) =>
        unwrap(
          browserApi().v1.workspaces[":slug"].suppliers.import.$post({
            param: { slug },
            json: { csv, dryRun, ...(fileName ? { fileName } : {}) },
          }),
        )
      }
      onClose={onClose}
    />
  );
}

function SupplierDialog({
  slug,
  supplier,
  onClose,
}: {
  slug: string;
  supplier: Supplier | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [form, setForm] = useState({
    name: supplier?.name ?? "",
    code: supplier?.code ?? "",
    contactName: supplier?.contactName ?? "",
    email: supplier?.email ?? "",
    phone: supplier?.phone ?? "",
    address: supplier?.address ?? "",
    certification: supplier?.certification ?? "",
    certificateExpiresOn: supplier?.certificateExpiresOn ?? "",
    notes: supplier?.notes ?? "",
    category: (supplier?.category ?? "goods") as SupplierCategory,
    serviceType: supplier?.serviceType ?? "",
  });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    const json = {
      name: form.name.trim(),
      code: form.code.trim() || null,
      contactName: form.contactName.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      address: form.address.trim() || null,
      certification: form.certification.trim() || null,
      certificateExpiresOn: form.certificateExpiresOn || null,
      notes: form.notes.trim() || null,
      category: form.category,
      serviceType: form.category === "service" ? form.serviceType.trim() || null : null,
    };
    const api = browserApi().v1.workspaces[":slug"].suppliers;
    try {
      if (supplier) await unwrap(api[":id"].$patch({ param: { slug, id: supplier.id }, json }));
      else await unwrap(api.$post({ param: { slug }, json }));
      toast.success(supplier ? `${json.name} saved` : `${json.name} added (pending approval)`);
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{supplier ? "Edit supplier" : "New supplier"}</DialogTitle>
            <DialogDescription>
              {supplier
                ? "Approval is changed separately, with the Approval button."
                : "New suppliers start as pending until someone approves them."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
              <Field>
                <FieldLabel htmlFor="supplier-name">Name</FieldLabel>
                <Input id="supplier-name" required maxLength={200} value={form.name} onChange={set("name")} />
              </Field>
              <Field>
                <FieldLabel htmlFor="supplier-code">Code</FieldLabel>
                <Input id="supplier-code" maxLength={40} value={form.code} onChange={set("code")} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="supplier-category">Kind</FieldLabel>
                <Select
                  value={form.category}
                  onValueChange={(v) => setForm((f) => ({ ...f, category: v as SupplierCategory }))}
                >
                  <SelectTrigger id="supplier-category" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {supplierCategories.map((c) => (
                        <SelectItem key={c} value={c}>
                          {supplierCategoryLabels[c]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {form.category === "service" && (
                <Field>
                  <FieldLabel htmlFor="supplier-service">Service</FieldLabel>
                  <Input
                    id="supplier-service"
                    maxLength={100}
                    placeholder="e.g. Pest control, laboratory, cleaning"
                    value={form.serviceType}
                    onChange={set("serviceType")}
                  />
                </Field>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="supplier-contact">Contact</FieldLabel>
                <Input
                  id="supplier-contact"
                  maxLength={200}
                  value={form.contactName}
                  onChange={set("contactName")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="supplier-email">Email</FieldLabel>
                <Input id="supplier-email" type="email" value={form.email} onChange={set("email")} />
              </Field>
              <Field>
                <FieldLabel htmlFor="supplier-phone">Phone</FieldLabel>
                <Input id="supplier-phone" maxLength={60} value={form.phone} onChange={set("phone")} />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="supplier-address">Address</FieldLabel>
              <Textarea
                id="supplier-address"
                rows={2}
                maxLength={1000}
                value={form.address}
                onChange={set("address")}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="supplier-cert">Certification</FieldLabel>
                <Input
                  id="supplier-cert"
                  maxLength={200}
                  placeholder="e.g. BRCGS Food Safety AA"
                  value={form.certification}
                  onChange={set("certification")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="supplier-cert-expiry">Certificate expires</FieldLabel>
                <Input
                  id="supplier-cert-expiry"
                  type="date"
                  value={form.certificateExpiresOn}
                  onChange={set("certificateExpiresOn")}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="supplier-notes">Notes</FieldLabel>
              <Textarea
                id="supplier-notes"
                rows={2}
                maxLength={4000}
                value={form.notes}
                onChange={set("notes")}
              />
            </Field>
          </FieldGroup>
          {supplier && <RecordAttachments entityType="supplier" entityId={supplier.id} />}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {supplier ? "Save" : "Add supplier"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ApprovalDialog({
  slug,
  supplier,
  onClose,
}: {
  slug: string;
  supplier: Supplier;
  onClose: () => void;
}) {
  const timeZone = useWorkspaceTimeZone();
  const router = useRouter();
  const { idx, can } = useWorkspace();
  const [pending, setPending] = useState(false);
  // Quality's view of this supplier: open non-conformances and whether they suggest suspension.
  const [standing, setStanding] = useState<{
    open: { id: string; reference: string; title: string; severity: string }[];
    advice: { suggest: boolean; reasons: string[] };
  } | null>(null);
  useEffect(() => {
    if (!can("quality")) return;
    unwrap(
      browserApi().v1.workspaces[":slug"].quality.suppliers[":id"].$get({ param: { slug, id: supplier.id } }),
    )
      .then(setStanding)
      .catch(() => setStanding(null));
  }, [can, slug, supplier.id]);
  const [status, setStatus] = useState<SupplierApprovalStatus>(
    supplier.approvalStatus === "pending" ? "approved" : supplier.approvalStatus,
  );
  const [reviewDueOn, setReviewDueOn] = useState(supplier.reviewDueOn ?? "");
  const [note, setNote] = useState("");
  // Set when open control issues block the approval (enforcement `block`): an override is asked for.
  const [blockedBy, setBlockedBy] = useState<string[] | null>(null);
  const [override, setOverride] = useState("");
  const decidedBy = supplier.approvalChangedBy ? idx.users.get(supplier.approvalChangedBy)?.name : undefined;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].suppliers[":id"].approval.$post({
          param: { slug, id: supplier.id },
          json: {
            status,
            note: note.trim() || null,
            reviewDueOn: reviewDueOn || null,
            ...(blockedBy && status === "approved" ? { controlsOverride: override.trim() } : {}),
          },
        }),
      );
      // Record that these non-conformances were weighed in the decision (needs quality manage).
      if (standing?.open.length && can("quality", "manage")) {
        await unwrap(
          browserApi().v1.workspaces[":slug"].quality.suppliers[":id"].review.$post({
            param: { slug, id: supplier.id },
            json: { nonconformanceIds: standing.open.map((n) => n.id) },
          }),
        ).catch(() => undefined);
      }
      toast.success(`${supplier.name}: ${supplierApprovalLabels[status].toLowerCase()}`);
      onClose();
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "supplier_controls_open") {
        setBlockedBy((err.details as { issues?: string[] } | undefined)?.issues ?? []);
      } else toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Supplier approval: {supplier.name}</DialogTitle>
            <DialogDescription>
              Your name and the time are recorded with this decision.
              {supplier.approvalChangedAt &&
                ` Last decided ${formatLongDate(supplier.approvalChangedAt, timeZone)}${decidedBy ? ` by ${decidedBy}` : ""}${supplier.approvalNote ? `: “${supplier.approvalNote}”` : "."}`}
            </DialogDescription>
          </DialogHeader>
          {standing && standing.open.length > 0 && (
            <div className="mt-3 rounded-md border bg-muted/40 p-3 text-sm">
              <div className="font-medium">
                {standing.open.length} open non-conformance{standing.open.length === 1 ? "" : "s"} from this
                supplier
              </div>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                {standing.open.map((n) => (
                  <li key={n.id}>
                    <a className="hover:underline" href={`/${slug}/quality/nonconformances/${n.id}`}>
                      {n.reference}
                    </a>{" "}
                    {n.title} ({n.severity})
                  </li>
                ))}
              </ul>
              {standing.advice.suggest && (
                <p className="mt-2">
                  Consider suspending: {standing.advice.reasons.join(", ")}. The decision is yours; deciding
                  here records these non-conformances against it.
                </p>
              )}
            </div>
          )}
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel id="approval-status-label">Decision</FieldLabel>
              <Select value={status} onValueChange={(v) => setStatus(v as SupplierApprovalStatus)}>
                <SelectTrigger aria-labelledby="approval-status-label" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {supplierApprovalStatuses.map((s) => (
                      <SelectItem key={s} value={s}>
                        {supplierApprovalLabels[s]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="approval-review">Review due</FieldLabel>
              <Input
                id="approval-review"
                type="date"
                value={reviewDueOn}
                onChange={(e) => setReviewDueOn(e.target.value)}
              />
              <FieldDescription>When this approval should be looked at again.</FieldDescription>
            </Field>
            {blockedBy && status === "approved" && (
              <div className="rounded-md border border-destructive/40 p-3 text-sm">
                <div className="font-medium">Open supplier control issues block this approval</div>
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {blockedBy.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
                <Field className="mt-3">
                  <FieldLabel htmlFor="approval-override">Approve anyway because</FieldLabel>
                  <Textarea
                    id="approval-override"
                    rows={2}
                    required
                    maxLength={2000}
                    placeholder="e.g. Sole source; audit booked for next month"
                    value={override}
                    onChange={(e) => setOverride(e.target.value)}
                  />
                  <FieldDescription>Recorded with the approval, with these issues.</FieldDescription>
                </Field>
              </div>
            )}
            <Field>
              <FieldLabel htmlFor="approval-note">Note</FieldLabel>
              <Textarea
                id="approval-note"
                rows={2}
                maxLength={2000}
                placeholder="What you checked"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              Record decision
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
