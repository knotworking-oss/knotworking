import {
  demandSourceLabels,
  formatWeek,
  type DemandCsvColumn,
  type DemandRowError,
  type DemandSource,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";

const sourceClasses: Record<DemandSource, string> = {
  manual: "bg-label-blue-bg text-label-blue",
  import: "bg-label-purple-bg text-label-purple",
  api: "bg-label-teal-bg text-label-teal",
  forecast: "bg-label-yellow-bg text-label-yellow",
};

/** Where a demand line's quantity came from: entered in the app, a CSV import, or the API. */
export function DemandSourceBadge({ source }: { source: DemandSource }) {
  return (
    <Badge className={`border-transparent ${sourceClasses[source]}`}>{demandSourceLabels[source]}</Badge>
  );
}

const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** A week as a column heading: "W46" over "9 Nov" (its Monday). */
export function WeekHeading({ periodStart }: { periodStart: string }) {
  return (
    <span className="flex flex-col items-end leading-tight">
      <span>W{formatWeek(periodStart).slice(-2)}</span>
      <span className="text-xs font-normal text-muted-foreground">
        {dayMonth.format(new Date(`${periodStart}T00:00:00Z`))}
      </span>
    </span>
  );
}

/** "2026-W46 (w/c 9 Nov 2026)". */
export const weekLabel = (periodStart: string) =>
  `${formatWeek(periodStart)} (w/c ${new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${periodStart}T00:00:00Z`))})`;

const columnLabels: Record<DemandCsvColumn, string> = {
  item: "Item",
  period: "Period",
  quantity: "Quantity",
  unit: "Unit",
  customer: "Customer",
  note: "Note",
  reference: "Reference",
};

/** Problems found in a CSV import or a batch of lines, one row each, by spreadsheet row. */
export function DemandRowErrors({ errors, limit = 100 }: { errors: DemandRowError[]; limit?: number }) {
  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16 pl-3">Row</TableHead>
            <TableHead className="w-28">Column</TableHead>
            <TableHead className="pr-3">Problem</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {errors.slice(0, limit).map((e, i) => (
            <TableRow key={`${e.row}-${e.column ?? ""}-${i}`}>
              <TableCell className="pl-3 tabular-nums">{e.row}</TableCell>
              <TableCell className="text-muted-foreground">
                {e.column ? columnLabels[e.column] : "—"}
              </TableCell>
              <TableCell className="pr-3 whitespace-normal text-label-red">{e.message}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {errors.length > limit && (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          And {errors.length - limit} more. Fix these and check again.
        </p>
      )}
    </div>
  );
}
