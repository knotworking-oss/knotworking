"use client";

import { useWorkspaceToday } from "@/lib/workspace-time";
import {
  complaintCategories,
  complaintCategoryLabels,
  complaintOpensNonconformance,
  complaintSourceLabels,
  complaintSources,
  qualitySeverities,
  qualitySeverityLabels,
  type ComplaintCategory,
  type ComplaintSource,
  type QualitySeverity,
} from "@knotworking/core";
import { Alert, AlertDescription } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Input } from "@knotworking/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import { Plus, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import { ComplaintStatusBadge, SeverityBadge } from "@/components/quality-badges";
import { stackedTable } from "@/components/stacked-table";
import { ExportCsvButton } from "@/components/export-csv-button";
import type { ComplaintRow } from "@/lib/api";
import { browserApi, unwrap } from "@/lib/auth-client";
import { collectPages, complaintsCsv } from "@/lib/csv-export";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { DateField, ItemLotFields, NONE, qualityApi, TextField, type ItemOption } from "../quality-forms";

export type ComplaintFilter = "unresolved" | "open" | "investigating" | "closed" | "all";

const filterLabels: Record<ComplaintFilter, string> = {
  unresolved: "Unresolved",
  open: "Open",
  investigating: "Investigating",
  closed: "Closed",
  all: "All",
};

/** The complaints register: filter, search, log a new one; each row opens the complaint. */
export function ComplaintsBoard({
  slug,
  status,
  q,
  complaints,
  total,
  items,
}: {
  slug: string;
  status: ComplaintFilter;
  q: string;
  complaints: ComplaintRow[];
  total: number;
  items: ItemOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const [logging, setLogging] = useState(false);
  const [search, setSearch] = useState(q);
  const go = (next: { status?: ComplaintFilter; q?: string }) => {
    const params = new URLSearchParams();
    const s = next.status ?? status;
    const text = next.q ?? search;
    if (s !== "unresolved") params.set("status", s);
    if (text.trim()) params.set("q", text.trim());
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Complaints</h2>
          <p className="text-sm text-muted-foreground">{total} shown</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ExportCsvButton
            name="Complaints"
            size="default"
            rows={async () =>
              complaintsCsv(
                await collectPages(async (offset) => {
                  const r = await unwrap(
                    browserApi().v1.workspaces[":slug"].quality.complaints.$get({
                      param: { slug },
                      query: { status, ...(q ? { q } : {}), limit: "500", offset: String(offset) },
                    }),
                  );
                  return { rows: r.complaints, total: r.total };
                }),
              )
            }
          />
          {can("quality", "write") && (
            <Button onClick={() => setLogging(true)}>
              <Plus data-icon="inline-start" /> Log complaint
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={status} onValueChange={(v) => go({ status: v as ComplaintFilter })}>
          <TabsList>
            {(Object.keys(filterLabels) as ComplaintFilter[]).map((f) => (
              <TabsTrigger key={f} value={f}>
                {filterLabels[f]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <form
          className="min-w-48 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            go({});
          }}
        >
          <Input
            type="search"
            aria-label="Search complaints"
            placeholder="Search reference, description, customer, lot code"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
      </div>

      {complaints.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {status === "unresolved" && !q ? "No unresolved complaints." : "No complaints match."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table className={stackedTable}>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Reference</TableHead>
                <TableHead>Received</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {complaints.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="pl-4" data-label="Reference">
                    <Link
                      href={`/${slug}/quality/complaints/${c.id}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {c.reference}
                    </Link>
                    <div className="line-clamp-1 max-w-72 text-xs text-muted-foreground">{c.description}</div>
                  </TableCell>
                  <TableCell data-label="Received">{formatLongDate(c.receivedOn)}</TableCell>
                  <TableCell data-label="Category">
                    {complaintCategoryLabels[c.category]}
                    <div className="text-xs text-muted-foreground">
                      {complaintSourceLabels[c.source]}
                      {c.customer ? ` · ${c.customer}` : ""}
                    </div>
                  </TableCell>
                  <TableCell data-label="Product">
                    {c.item ? `${c.item.code} ${c.item.name}` : "—"}
                    {(c.lot || c.reportedLotCode) && (
                      <div className="font-mono text-xs text-muted-foreground">
                        {c.lot?.lotCode ?? c.reportedLotCode}
                      </div>
                    )}
                  </TableCell>
                  <TableCell data-label="Severity">
                    <SeverityBadge severity={c.severity} />
                  </TableCell>
                  <TableCell data-label="Status">
                    <ComplaintStatusBadge status={c.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {logging && <LogComplaintDialog slug={slug} items={items} onClose={() => setLogging(false)} />}
    </div>
  );
}

function LogComplaintDialog({
  slug,
  items,
  onClose,
}: {
  slug: string;
  items: ItemOption[];
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const router = useRouter();
  const [receivedOn, setReceivedOn] = useState(today);
  const [source, setSource] = useState<ComplaintSource>("consumer");
  const [category, setCategory] = useState<ComplaintCategory>("quality");
  const [severity, setSeverity] = useState<QualitySeverity>("minor");
  const [itemId, setItemId] = useState(NONE);
  const [lotId, setLotId] = useState(NONE);
  const [reportedLotCode, setReportedLotCode] = useState("");
  const [customer, setCustomer] = useState("");
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [description, setDescription] = useState("");
  const opensNc = complaintOpensNonconformance({ severity, category });

  return (
    <HaccpDialog
      title="Log complaint"
      description="Record what was reported. The investigation, root cause and response are added on the complaint's page."
      submitLabel="Log complaint"
      wide
      disabled={!description.trim()}
      onClose={onClose}
      onSubmit={async () => {
        const created = await unwrap(
          qualityApi().complaints.$post({
            param: { slug },
            json: {
              receivedOn,
              source,
              category,
              severity,
              description: description.trim(),
              ...(itemId !== NONE ? { itemId } : {}),
              ...(lotId !== NONE ? { lotId } : {}),
              ...(reportedLotCode.trim() ? { reportedLotCode: reportedLotCode.trim() } : {}),
              ...(customer.trim() ? { customer: customer.trim() } : {}),
              ...(name.trim() ? { complainantName: name.trim() } : {}),
              ...(contact.trim() ? { complainantContact: contact.trim() } : {}),
            },
          }),
        );
        router.push(`/${slug}/quality/complaints/${created.id}`);
        return created.nonconformances.length
          ? `${created.reference} logged; ${created.nonconformances[0]!.reference} opened`
          : `${created.reference} logged`;
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <DateField id="c-received" label="Received" value={receivedOn} onChange={setReceivedOn} max={today} />
        <SelectField
          id="c-source"
          label="From"
          value={source}
          onChange={(v) => setSource(v as ComplaintSource)}
          options={complaintSources.map((s) => [s, complaintSourceLabels[s]] as const)}
        />
        <SelectField
          id="c-category"
          label="Category"
          value={category}
          onChange={(v) => setCategory(v as ComplaintCategory)}
          options={complaintCategories.map((c) => [c, complaintCategoryLabels[c]] as const)}
        />
        <SelectField
          id="c-severity"
          label="Severity"
          value={severity}
          onChange={(v) => setSeverity(v as QualitySeverity)}
          options={qualitySeverities.map((s) => [s, qualitySeverityLabels[s]] as const)}
        />
        <ItemLotFields
          slug={slug}
          items={items}
          itemId={itemId}
          lotId={lotId}
          onItem={setItemId}
          onLot={setLotId}
          idPrefix="c"
        />
        <TextField
          id="c-reported-lot"
          label="Lot or date code as reported"
          rows={1}
          maxLength={100}
          value={reportedLotCode}
          onChange={setReportedLotCode}
        />
        <TextField
          id="c-customer"
          label="Customer account"
          rows={1}
          maxLength={200}
          value={customer}
          onChange={setCustomer}
        />
        <TextField id="c-name" label="Complainant" rows={1} maxLength={200} value={name} onChange={setName} />
        <TextField
          id="c-contact"
          label="Contact details"
          rows={1}
          maxLength={500}
          value={contact}
          onChange={setContact}
          description="Kept for replying to them; never returned to API tokens or agents, or written to the sync log."
        />
      </div>
      <TextField
        id="c-description"
        label="What was reported"
        required
        rows={4}
        maxLength={8000}
        value={description}
        onChange={setDescription}
      />
      {opensNc && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>This complaint will open a non-conformance straight away.</AlertDescription>
        </Alert>
      )}
    </HaccpDialog>
  );
}
