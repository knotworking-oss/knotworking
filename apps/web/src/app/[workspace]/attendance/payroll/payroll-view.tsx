"use client";

import {
  decimalHours,
  isPayPeriod,
  lastFinishedPayPeriod,
  nextPayPeriod,
  payPeriodLabels,
  payPeriodProblem,
  payrollFormats,
  previousPayPeriod,
  shiftIssueLabels,
  staffDisplayName,
  todayInZone,
  type AttendanceSettings,
} from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { ChevronLeft, ChevronRight, Download, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { StaffNumber } from "@/components/people-badges";
import { stackedTable } from "@/components/stacked-table";
import type { PayrollPreview } from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { AttendanceNav } from "../attendance-nav";

/** Attendance → Payroll: hours per person for a period, checked, then downloaded in the chosen format. */
export function PayrollView({
  slug,
  preview,
  payPeriod,
}: {
  slug: string;
  preview: PayrollPreview;
  /** The workspace's pay period setting (attendance settings) and time zone. */
  payPeriod: Pick<AttendanceSettings, "payPeriodKind" | "payPeriodAnchor" | "timeZone">;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const go = (patch: Partial<{ from: string; to: string; format: string }>) => {
    const next = { from: preview.from, to: preview.to, format: preview.format.id, ...patch };
    router.replace(`${pathname}?${new URLSearchParams(next)}`);
  };
  const download = `/api/v1/workspaces/${slug}/attendance/payroll.csv?${new URLSearchParams({
    from: preview.from,
    to: preview.to,
    format: preview.format.id,
  })}`;
  const blocked = preview.problems.length > 0;
  const setting = { kind: payPeriod.payPeriodKind, anchor: payPeriod.payPeriodAnchor };
  const usable = payPeriodProblem(setting) === null;
  const range = { from: preview.from, to: preview.to };
  const aligned = usable && isPayPeriod(range, setting);
  const goTo = (period: { from: string; to: string }) => go(period);
  const total = preview.rows.reduce((n, r) => n + r.basicMinutes + r.overtimeMinutes, 0);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8 sm:px-6">
      <h2 className="text-xl font-semibold tracking-tight">Payroll export</h2>
      <AttendanceNav slug={slug} />

      {usable && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            Pay period: {payPeriodLabels[payPeriod.payPeriodKind].toLowerCase()}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!aligned}
            onClick={() => goTo(previousPayPeriod(range, setting))}
          >
            <ChevronLeft data-icon="inline-start" /> Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!aligned}
            onClick={() => goTo(nextPayPeriod(range, setting))}
          >
            Next <ChevronRight data-icon="inline-end" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => goTo(lastFinishedPayPeriod(todayInZone(payPeriod.timeZone), setting))}
          >
            Last finished
          </Button>
          {!aligned && <span className="text-xs text-muted-foreground">Custom dates (not a pay period)</span>}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-40">
          <FieldLabel htmlFor="pay-from">From</FieldLabel>
          <Input
            id="pay-from"
            type="date"
            value={preview.from}
            onChange={(e) => e.target.value && go({ from: e.target.value })}
          />
        </Field>
        <Field className="w-40">
          <FieldLabel htmlFor="pay-to">To</FieldLabel>
          <Input
            id="pay-to"
            type="date"
            value={preview.to}
            min={preview.from}
            onChange={(e) => e.target.value && go({ to: e.target.value })}
          />
        </Field>
        <Field className="w-64">
          <FieldLabel id="pay-format-label">Format</FieldLabel>
          <Select value={preview.format.id} onValueChange={(format) => go({ format })}>
            <SelectTrigger aria-labelledby="pay-format-label" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {payrollFormats.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.label}
                    {!f.verified && " (unverified)"}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Button asChild={!blocked} disabled={blocked || preview.rows.length === 0}>
          {blocked ? (
            <span>
              <Download data-icon="inline-start" /> Download
            </span>
          ) : (
            <a href={download} download>
              <Download data-icon="inline-start" /> Download
            </a>
          )}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{preview.format.description}</p>

      {blocked && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Can't export yet</AlertTitle>
          <AlertDescription>
            {preview.problems.join(" ")}{" "}
            <Link className="underline" href={`/${slug}/attendance/settings`}>
              Open settings
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {preview.warnings.map((w) => (
        <Alert key={w}>
          <TriangleAlert />
          <AlertDescription>{w}</AlertDescription>
        </Alert>
      ))}

      {preview.exceptions.length > 0 && (
        <Card className="gap-0 py-0">
          <div className="border-b px-4 py-2.5">
            <h3 className="font-medium">To fix before paying</h3>
            <p className="text-xs text-muted-foreground">
              These shifts count as 0 hours until the missing clock event is added.
            </p>
          </div>
          <ul className="divide-y text-sm">
            {preview.exceptions.map((x, i) => (
              <li
                key={`${x.staff.id}-${i}`}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
              >
                <span>
                  <span className="font-medium">{staffDisplayName(x.staff)}</span> ·{" "}
                  {formatLongDate(x.shift.date)}
                </span>
                <Link
                  className="text-sm underline"
                  href={`/${slug}/attendance/shifts?from=${x.shift.date}&to=${x.shift.date}`}
                >
                  {x.shift.issue ? shiftIssueLabels[x.shift.issue] : "Check"}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {preview.rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No paid hours in this period.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table className={stackedTable}>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Person</TableHead>
                <TableHead>Payroll ref.</TableHead>
                <TableHead className="text-right">Shifts</TableHead>
                <TableHead className="text-right">Basic</TableHead>
                <TableHead className="text-right">Overtime</TableHead>
                <TableHead className="pr-4 text-right">Total hours</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.rows.map((r) => (
                <TableRow key={r.staffId}>
                  <TableCell className="pl-4" data-primary>
                    <span className="font-medium">{staffDisplayName(r)}</span>{" "}
                    <span className="text-xs text-muted-foreground">
                      <StaffNumber value={r.staffNumber} />
                    </span>
                  </TableCell>
                  <TableCell data-label="Payroll ref.">
                    {r.payrollReference ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums" data-label="Shifts">
                    {r.shifts}
                  </TableCell>
                  <TableCell className="text-right tabular-nums" data-label="Basic">
                    {decimalHours(r.basicMinutes)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums" data-label="Overtime">
                    {decimalHours(r.overtimeMinutes)}
                  </TableCell>
                  <TableCell className="pr-4 text-right font-medium tabular-nums" data-label="Total">
                    {decimalHours(r.basicMinutes + r.overtimeMinutes)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="pl-4 font-medium" colSpan={5}>
                  Total
                </TableCell>
                <TableCell className="pr-4 text-right font-medium tabular-nums max-md:ml-auto">
                  {decimalHours(total)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
