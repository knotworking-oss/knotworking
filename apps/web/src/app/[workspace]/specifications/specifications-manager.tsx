"use client";

import {
  specificationKindLabels,
  specificationKindOf,
  specificationKinds,
  type SpecificationKind,
  type SpecificationReviewFilter,
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
import { Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { SpecificationReviewBadge, SpecificationVersionBadge } from "@/components/specification-badges";
import type { Item, SpecificationRow, Supplier } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

type StatusFilter = "active" | "archived" | "all";
interface Filters {
  q?: string | undefined;
  status: StatusFilter;
  kind?: SpecificationKind | undefined;
  review?: SpecificationReviewFilter | undefined;
}

const ALL = "all";
const NONE = "none";

/** Specifications → the register with search and filters, and the new-specification dialog. */
export function SpecificationsManager({
  slug,
  specifications,
  total,
  items,
  suppliers,
  filters,
}: {
  slug: string;
  specifications: SpecificationRow[];
  total: number;
  items: Item[];
  suppliers: Supplier[];
  filters: Filters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const timeZone = useWorkspaceTimeZone();
  const canWrite = useWorkspace().can("specifications", "write");
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState(filters.q ?? "");

  function applyFilters(next: Partial<Filters>) {
    const merged = { ...filters, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.status !== "active") params.set("status", merged.status);
    if (merged.kind) params.set("kind", merged.kind);
    if (merged.review) params.set("review", merged.review);
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  }
  const filtered = !!(filters.q || filters.kind || filters.review || filters.status !== "active");

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Specifications</h2>
          <p className="text-sm text-muted-foreground">{total} shown</p>
        </div>
        {canWrite && (
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" /> New specification
          </Button>
        )}
      </div>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters({ q: query.trim() || undefined });
        }}
      >
        <Input
          className="w-64"
          placeholder="Search code, title, item, supplier"
          aria-label="Search specifications"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          value={filters.kind ?? ALL}
          onValueChange={(v) => applyFilters({ kind: v === ALL ? undefined : (v as SpecificationKind) })}
        >
          <SelectTrigger className="w-40" aria-label="Kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ALL}>All kinds</SelectItem>
              {specificationKinds.map((k) => (
                <SelectItem key={k} value={k}>
                  {specificationKindLabels[k]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select value={filters.status} onValueChange={(v) => applyFilters({ status: v as StatusFilter })}>
          <SelectTrigger className="w-36" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant={filters.review === "attention" ? "secondary" : "outline"}
          aria-pressed={filters.review === "attention"}
          onClick={() => applyFilters({ review: filters.review === "attention" ? undefined : "attention" })}
        >
          Needs attention
        </Button>
        <Button
          type="button"
          variant={filters.review === "overdue" ? "secondary" : "outline"}
          aria-pressed={filters.review === "overdue"}
          onClick={() => applyFilters({ review: filters.review === "overdue" ? undefined : "overdue" })}
        >
          Review overdue
        </Button>
      </form>

      {specifications.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {filtered
            ? "No specifications match these filters."
            : "No specifications yet. Create one for an ingredient, packaging or product."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Code</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Agreed with</TableHead>
                <TableHead>Approved</TableHead>
                <TableHead>Review due</TableHead>
                <TableHead className="pr-4">Draft</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {specifications.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="pl-4 font-mono text-xs">{s.code}</TableCell>
                  <TableCell className="font-medium">
                    <Link href={`/${slug}/specifications/${s.id}`} className="hover:underline">
                      {s.title}
                    </Link>
                    {s.status === "archived" && (
                      <Badge variant="secondary" className="ml-2">
                        Archived
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs">{s.item.code}</span> {s.item.name}
                    <span className="ml-1 text-xs text-muted-foreground">
                      · {specificationKindLabels[s.kind]}
                    </span>
                  </TableCell>
                  <TableCell>
                    {s.supplierName ?? s.customerName ?? (
                      <span className="text-muted-foreground">Internal</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {s.approvedVersion ? (
                      <SpecificationVersionBadge
                        status="approved"
                        versionNumber={s.approvedVersion.versionNumber}
                      />
                    ) : (
                      <span className="text-muted-foreground">Not approved</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-1">
                      {s.approvedVersion?.reviewDueOn
                        ? formatLongDate(s.approvedVersion.reviewDueOn, timeZone)
                        : "—"}
                      {s.reviewState !== "none" && (
                        <SpecificationReviewBadge
                          state={s.reviewState}
                          reviewDueOn={s.approvedVersion?.reviewDueOn}
                        />
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="pr-4">
                    {s.draftVersion ? (
                      <SpecificationVersionBadge
                        status="draft"
                        versionNumber={s.draftVersion.versionNumber}
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {creating && (
        <NewSpecificationDialog
          slug={slug}
          items={items}
          suppliers={suppliers}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function NewSpecificationDialog({
  slug,
  items,
  suppliers,
  onClose,
}: {
  slug: string;
  items: Item[];
  suppliers: Supplier[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [itemId, setItemId] = useState("");
  const [supplierId, setSupplierId] = useState(NONE);
  const [customerName, setCustomerName] = useState("");
  const item = items.find((i) => i.id === itemId);
  const kind = item ? specificationKindOf(item.type) : null;
  const sortedItems = [...items].sort((a, b) => a.code.localeCompare(b.code));

  async function create(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const created = await unwrap(
        browserApi().v1.workspaces[":slug"].specifications.$post({
          param: { slug },
          json: {
            code: code.trim(),
            title: title.trim(),
            itemId,
            supplierId: kind !== "product" && supplierId !== NONE ? supplierId : null,
            customerName: kind === "product" ? customerName.trim() || null : null,
          },
        }),
      );
      toast.success(`${created.code} created`);
      router.push(`/${slug}/specifications/${created.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(e) => void create(e)}>
          <DialogHeader>
            <DialogTitle>New specification</DialogTitle>
            <DialogDescription>
              Pick the item it specifies and who it is agreed with. You fill in the content as a draft, which
              a manager approves.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
              <Field>
                <FieldLabel htmlFor="spec-code">Document number</FieldLabel>
                <Input
                  id="spec-code"
                  required
                  maxLength={40}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="spec-title">Title</FieldLabel>
                <Input
                  id="spec-title"
                  required
                  maxLength={200}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="spec-item">Item</FieldLabel>
              <Select
                value={itemId}
                onValueChange={(v) => {
                  setItemId(v);
                  const picked = items.find((i) => i.id === v);
                  if (!title && picked) setTitle(picked.name);
                }}
              >
                <SelectTrigger id="spec-item" className="w-full">
                  <SelectValue placeholder="Choose an item" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {sortedItems.map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {i.code} · {i.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {kind && kind !== "product" && (
              <Field>
                <FieldLabel htmlFor="spec-supplier">Supplier</FieldLabel>
                <Select value={supplierId} onValueChange={setSupplierId}>
                  <SelectTrigger id="spec-supplier" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={NONE}>None: an internal standard</SelectItem>
                      {suppliers.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  A supplier&apos;s specification needs their agreement before approval.
                </FieldDescription>
              </Field>
            )}
            {kind === "product" && (
              <Field>
                <FieldLabel htmlFor="spec-customer">Customer</FieldLabel>
                <Input
                  id="spec-customer"
                  maxLength={200}
                  placeholder="Leave empty for our own specification"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
              </Field>
            )}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || !itemId}>
              {pending && <Spinner data-icon="inline-start" />} Create specification
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
