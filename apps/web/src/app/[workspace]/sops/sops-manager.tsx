"use client";

import { DEFAULT_SOP_REVIEW_INTERVAL_MONTHS } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Label } from "@knotworking/ui/components/label";
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
import { SopFlagBadge, SopReviewBadge } from "@/components/sop-badges";
import type { SopRow } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";

interface Filters {
  q?: string | undefined;
  category?: string | undefined;
  due?: "overdue" | "soon" | undefined;
  status: "active" | "all";
}

const ANY = "any";

/** SOPs → the list with filters, and the "new SOP" dialog. */
export function SopsManager({
  slug,
  sops,
  total,
  categories,
  filters,
}: {
  slug: string;
  sops: SopRow[];
  total: number;
  categories: string[];
  filters: Filters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const canWrite = useWorkspace().can("sops", "write");
  const canManage = useWorkspace().can("sops", "manage");
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState(filters.q ?? "");

  function applyFilters(next: Partial<Filters>) {
    const merged = { ...filters, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.category) params.set("category", merged.category);
    if (merged.due) params.set("due", merged.due);
    if (merged.status === "all") params.set("status", "all");
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  }
  const filtered = Boolean(filters.q || filters.category || filters.due);

  return (
    <div className="workspace-content flex flex-col gap-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Standard operating procedures</h2>
          <p className="text-sm text-muted-foreground">{total} shown</p>
        </div>
        <Button asChild variant="outline">
          <Link href={`/${slug}/sops/copies`}>Controlled copies</Link>
        </Button>
        {canManage && (
          <Button asChild variant="outline">
            <Link href={`/${slug}/sops/outstanding`}>Acknowledgements outstanding</Link>
          </Button>
        )}
        {canWrite && (
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" /> New SOP
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
          placeholder="Search code or title"
          aria-label="Search SOPs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          value={filters.category ?? ANY}
          onValueChange={(v) => applyFilters({ category: v === ANY ? undefined : v })}
        >
          <SelectTrigger className="w-48" aria-label="Category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ANY}>All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          value={filters.due ?? ANY}
          onValueChange={(v) => applyFilters({ due: v === ANY ? undefined : (v as "overdue" | "soon") })}
        >
          <SelectTrigger className="w-48" aria-label="Review">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ANY}>Any review date</SelectItem>
              <SelectItem value="overdue">Review overdue</SelectItem>
              <SelectItem value="soon">Due within 30 days</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 pl-1">
          <Checkbox
            id="sops-archived"
            checked={filters.status === "all"}
            onCheckedChange={(on) => applyFilters({ status: on === true ? "all" : "active" })}
          />
          <Label htmlFor="sops-archived">Show archived</Label>
        </div>
      </form>

      {sops.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {filtered ? "No SOPs match these filters." : "No SOPs yet."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Code</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Current</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead>Review due</TableHead>
                <TableHead className="pr-4">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sops.map((sop) => (
                <TableRow key={sop.id}>
                  <TableCell className="pl-4 font-mono text-xs">{sop.code}</TableCell>
                  <TableCell>
                    <Link href={`/${slug}/sops/${sop.id}`} className="font-medium hover:underline">
                      {sop.title}
                    </Link>
                  </TableCell>
                  <TableCell>{sop.category ?? "—"}</TableCell>
                  <TableCell>{sop.currentVersion ? `v${sop.currentVersion.versionNumber}` : "—"}</TableCell>
                  <TableCell>
                    {sop.currentVersion?.effectiveOn ? formatLongDate(sop.currentVersion.effectiveOn) : "—"}
                  </TableCell>
                  <TableCell
                    className={sop.reviewState === "overdue" ? "font-medium text-destructive" : undefined}
                  >
                    {sop.currentVersion?.reviewDueOn ? formatLongDate(sop.currentVersion.reviewDueOn) : "—"}
                  </TableCell>
                  <TableCell className="pr-4">
                    <span className="flex flex-wrap gap-1">
                      {sop.status === "archived" && <SopFlagBadge kind="archived" />}
                      {sop.hasDraft && canWrite && <SopFlagBadge kind="draft" />}
                      {sop.inReview && <SopFlagBadge kind="in_review" />}
                      {sop.acknowledged && <SopFlagBadge kind="acknowledged" />}
                      <SopReviewBadge reviewDueOn={sop.currentVersion?.reviewDueOn} />
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {creating && <NewSopDialog slug={slug} onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewSopDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [form, setForm] = useState({
    code: "",
    title: "",
    category: "",
    reviewIntervalMonths: String(DEFAULT_SOP_REVIEW_INTERVAL_MONTHS),
  });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const created = await unwrap(
        browserApi().v1.workspaces[":slug"].sops.$post({
          param: { slug },
          json: {
            code: form.code.trim(),
            title: form.title.trim(),
            category: form.category.trim() || null,
            reviewIntervalMonths: Number(form.reviewIntervalMonths) || DEFAULT_SOP_REVIEW_INTERVAL_MONTHS,
          },
        }),
      );
      toast.success(`${created.code} created. Write the first draft.`);
      onClose();
      router.push(`/${slug}/sops/${created.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>New SOP</DialogTitle>
            <DialogDescription>
              It has no effect until its first version is submitted and approved.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
              <Field>
                <FieldLabel htmlFor="sop-code">Code</FieldLabel>
                <Input
                  id="sop-code"
                  required
                  maxLength={40}
                  placeholder="SOP-001"
                  value={form.code}
                  onChange={set("code")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sop-title">Title</FieldLabel>
                <Input id="sop-title" required maxLength={300} value={form.title} onChange={set("title")} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="sop-category">Category</FieldLabel>
                <Input
                  id="sop-category"
                  maxLength={80}
                  placeholder="e.g. Cleaning"
                  value={form.category}
                  onChange={set("category")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sop-interval">Review every (months)</FieldLabel>
                <Input
                  id="sop-interval"
                  type="number"
                  min={1}
                  max={120}
                  value={form.reviewIntervalMonths}
                  onChange={set("reviewIntervalMonths")}
                />
              </Field>
            </div>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              Create SOP
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
