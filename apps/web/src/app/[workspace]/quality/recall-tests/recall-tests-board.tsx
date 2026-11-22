"use client";

import { useWorkspaceToday } from "@/lib/workspace-time";
import {
  recallDirectionLabels,
  recallDirections,
  recallTestResult,
  type RecallDirection,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Ban, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import { RecordFilesButton } from "@/components/record-attachments";
import { RecallResultBadge } from "@/components/quality-badges";
import { stackedTable } from "@/components/stacked-table";
import type { RecallTestRow } from "@/lib/api";
import { errorMessage, unwrap } from "@/lib/auth-client";
import { toast } from "sonner";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { DateField, ItemLotFields, NONE, qualityApi, TextField, type ItemOption } from "../quality-forms";

const minutes = (n: number) =>
  n < 60 ? `${n} min` : n % 60 === 0 ? `${n / 60} h` : `${Math.floor(n / 60)} h ${n % 60} min`;

/** Mock recall tests: a lot traced and reconciled against the clock, recorded in person, voided not edited. */
export function RecallTestsBoard({
  slug,
  tests,
  items,
}: {
  slug: string;
  tests: RecallTestRow[];
  items: (ItemOption & { unit: string })[];
}) {
  const { can } = useWorkspace();
  const [recording, setRecording] = useState(false);
  const [voiding, setVoiding] = useState<RecallTestRow | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Mock recall tests</h2>
        {can("quality", "write") && (
          <Button onClick={() => setRecording(true)}>
            <Plus data-icon="inline-start" /> Record test
          </Button>
        )}
      </div>
      {tests.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No recall test on record yet.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table className={stackedTable}>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Reference</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Lot</TableHead>
                <TableHead>Time taken</TableHead>
                <TableHead>Accounted for</TableHead>
                <TableHead>Result</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tests.map((t) => (
                <TableRow key={t.id} className={t.voidedAt ? "text-muted-foreground" : undefined}>
                  <TableCell className="pl-4" data-label="Reference">
                    <span className="font-mono text-xs">{t.reference}</span>
                    {t.scenario && (
                      <div className="line-clamp-1 max-w-64 text-xs text-muted-foreground">{t.scenario}</div>
                    )}
                    {t.voidReason && <div className="text-xs">Voided: {t.voidReason}</div>}
                  </TableCell>
                  <TableCell data-label="Date">{formatLongDate(t.conductedOn)}</TableCell>
                  <TableCell data-label="Lot">
                    {t.lot ? (
                      <Link
                        className="font-mono text-xs hover:underline"
                        href={`/${slug}/stock/lots/${t.lot.id}`}
                      >
                        {t.lot.lotCode}
                      </Link>
                    ) : (
                      "—"
                    )}
                    {t.lot?.item && <div className="text-xs text-muted-foreground">{t.lot.item.name}</div>}
                  </TableCell>
                  <TableCell data-label="Time taken">{minutes(t.durationMinutes)}</TableCell>
                  <TableCell data-label="Accounted for">
                    {t.quantityTraced} / {t.quantityExpected} {t.unit}
                    {t.reconciledPercent !== null && (
                      <div className="text-xs text-muted-foreground">{t.reconciledPercent}%</div>
                    )}
                  </TableCell>
                  <TableCell data-label="Result">
                    <RecallResultBadge passed={t.passed} voided={Boolean(t.voidedAt)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <RecordFilesButton
                      entityType="quality_recall_test"
                      entityId={t.id}
                      title="Recall test files"
                      description={`${t.reference}: trace sheets and photos. Files can be added but not removed, as the test itself is never edited.`}
                    />
                    {can("quality", "manage") && !t.voidedAt && (
                      <Button size="sm" variant="ghost" onClick={() => setVoiding(t)}>
                        <Ban data-icon="inline-start" /> Void
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {recording && <RecordDialog slug={slug} items={items} onClose={() => setRecording(false)} />}
      {voiding && <VoidDialog slug={slug} test={voiding} onClose={() => setVoiding(null)} />}
    </div>
  );
}

/** `YYYY-MM-DDTHH:mm` in local time, for datetime-local inputs. */
const localNow = (offsetMinutes = 0) => {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function RecordDialog({
  slug,
  items,
  onClose,
}: {
  slug: string;
  items: (ItemOption & { unit: string })[];
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const [conductedOn, setConductedOn] = useState(today);
  const [itemId, setItemId] = useState(NONE);
  const [lotId, setLotId] = useState(NONE);
  const [direction, setDirection] = useState<RecallDirection>("both");
  const [scenario, setScenario] = useState("");
  const [startedAt, setStartedAt] = useState(localNow(-120));
  const [completedAt, setCompletedAt] = useState(localNow());
  const [expected, setExpected] = useState("");
  const [traced, setTraced] = useState("");
  const [notes, setNotes] = useState("");
  const unit = items.find((i) => i.id === itemId)?.unit ?? "";
  const [filling, setFilling] = useState(false);
  /** Starts from the lot's stock ledger and (with production) its batch trace; the person edits the figures. */
  async function prefill() {
    setFilling(true);
    try {
      const p = await unwrap(
        qualityApi()["recall-tests"].prefill.$get({ param: { slug }, query: { lotId, direction } }),
      );
      setExpected(String(p.quantityExpected));
      setTraced(String(p.quantityTraced));
      setNotes(p.notes);
      toast.success("Filled from the lot's trace: check the figures against what you actually traced");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setFilling(false);
    }
  }
  const ready =
    lotId !== NONE &&
    expected !== "" &&
    traced !== "" &&
    startedAt !== "" &&
    completedAt !== "" &&
    completedAt >= startedAt;
  const preview = ready
    ? recallTestResult({
        startedAt: new Date(startedAt),
        completedAt: new Date(completedAt),
        quantityExpected: Number(expected),
        quantityTraced: Number(traced),
      })
    : null;
  return (
    <HaccpDialog
      title="Record a mock recall test"
      description="Your record of the exercise, in person. The result is worked out when it is saved and never changes."
      submitLabel="Record"
      wide
      disabled={!ready}
      onClose={onClose}
      onSubmit={async () => {
        const t = await unwrap(
          qualityApi()["recall-tests"].$post({
            param: { slug },
            json: {
              conductedOn,
              lotId,
              direction,
              ...(scenario.trim() ? { scenario: scenario.trim() } : {}),
              startedAt: new Date(startedAt).toISOString(),
              completedAt: new Date(completedAt).toISOString(),
              quantityExpected: Number(expected),
              quantityTraced: Number(traced),
              ...(notes.trim() ? { notes: notes.trim() } : {}),
            },
          }),
        );
        return `${t.reference} recorded: ${t.passed ? "passed" : "failed"}`;
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <DateField id="r-date" label="Date" value={conductedOn} onChange={setConductedOn} max={today} />
        <SelectField
          id="r-direction"
          label="Direction"
          value={direction}
          onChange={(v) => setDirection(v as RecallDirection)}
          options={recallDirections.map((d) => [d, recallDirectionLabels[d]] as const)}
        />
        <ItemLotFields
          slug={slug}
          items={items}
          itemId={itemId}
          lotId={lotId}
          onItem={setItemId}
          onLot={setLotId}
          idPrefix="r"
          lotRequired
        />
        <div className="sm:col-span-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={lotId === NONE || filling}
            onClick={prefill}
          >
            Fill quantities and notes from the lot's trace
          </Button>
        </div>
        <Field>
          <FieldLabel htmlFor="r-start">Started</FieldLabel>
          <Input
            id="r-start"
            type="datetime-local"
            required
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="r-end">Finished</FieldLabel>
          <Input
            id="r-end"
            type="datetime-local"
            required
            value={completedAt}
            onChange={(e) => setCompletedAt(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="r-expected">Quantity of the lot{unit ? ` (${unit})` : ""}</FieldLabel>
          <Input
            id="r-expected"
            type="number"
            min={0}
            step="any"
            required
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="r-traced">Accounted for{unit ? ` (${unit})` : ""}</FieldLabel>
          <Input
            id="r-traced"
            type="number"
            min={0}
            step="any"
            required
            value={traced}
            onChange={(e) => setTraced(e.target.value)}
          />
        </Field>
      </div>
      <TextField
        id="r-scenario"
        label="Scenario"
        rows={2}
        maxLength={2000}
        value={scenario}
        onChange={setScenario}
        placeholder="e.g. Retailer reports glass in product"
      />
      <TextField id="r-notes" label="Notes" rows={2} value={notes} onChange={setNotes} />
      {preview && (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <RecallResultBadge passed={preview.passed} />
          {minutes(preview.durationMinutes)}
          {preview.withinTime ? " (within target)" : " (over target)"} ·{" "}
          {preview.reconciledPercent === null
            ? "nothing expected"
            : `${preview.reconciledPercent}% accounted for`}
        </p>
      )}
    </HaccpDialog>
  );
}

function VoidDialog({ slug, test, onClose }: { slug: string; test: RecallTestRow; onClose: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <HaccpDialog
      title={`Void ${test.reference}`}
      description="A voided test stays on the list, marked, and no longer counts as the yearly test. This can't be undone."
      submitLabel="Void"
      disabled={!reason.trim()}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          qualityApi()["recall-tests"][":id"].void.$post({
            param: { slug, id: test.id },
            json: { reason: reason.trim() },
          }),
        );
        return `${test.reference} voided`;
      }}
    >
      <TextField
        id="v-reason"
        label="Why"
        required
        rows={2}
        maxLength={2000}
        value={reason}
        onChange={setReason}
      />
    </HaccpDialog>
  );
}
