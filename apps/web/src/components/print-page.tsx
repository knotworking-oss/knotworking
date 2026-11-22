import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import { PrintButton } from "@/components/print-button";
import { describeRange, printDateTime, type DayRange } from "@/lib/print";

/**
 * A print-ready page: the usual app header and a "Print" button on screen, an A4 sheet in the
 * middle, and on paper nothing but the sheet (black on white, app chrome hidden; the rules are in
 * `globals.css`). Pages put their content inside; `controls` go above the sheet and are hidden
 * when printed.
 */
export function PrintPage({
  crumbs,
  controls,
  children,
}: {
  /** Breadcrumb for the app header (screen only). */
  crumbs: ReactNode;
  /** Filters and links above the sheet (screen only). */
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader actions={<PrintButton />}>{crumbs}</PageHeader>
      <div className="print-scroll flex-1 overflow-y-auto bg-muted/40 print:bg-white">
        <div className="mx-auto flex w-full max-w-[210mm] flex-col gap-3 px-3 py-4 print:max-w-none print:p-0">
          {controls && <div className="flex flex-col gap-3 print:hidden">{controls}</div>}
          <article className="print-sheet min-h-[120mm] w-full rounded-sm p-[12mm] text-[13px] leading-snug shadow-sm ring-1 ring-black/10 print:min-h-0 print:rounded-none print:p-0 print:shadow-none print:ring-0">
            {children}
          </article>
        </div>
      </div>
    </>
  );
}

/** The top of a sheet: who it is for, what it is, and when it was printed. */
export function PrintHeading({
  workspace,
  title,
  subtitle,
  badge,
  timeZone,
}: {
  workspace: string;
  title: string;
  subtitle?: ReactNode;
  badge?: ReactNode;
  /** The workspace's time zone, for when the sheet was printed. */
  timeZone?: string;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b-2 border-black pb-3">
      <div className="min-w-0">
        <p className="text-[11px] tracking-wide uppercase">{workspace}</p>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[13px] text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="flex flex-col items-end gap-1 text-right text-[11px] text-muted-foreground">
        {badge}
        <span suppressHydrationWarning>Printed {printDateTime(new Date(), timeZone)}</span>
      </div>
    </header>
  );
}

/** A boxed warning that stays on paper: a draft label, a record range with nothing in it. */
export function PrintNotice({ children, strong }: { children: ReactNode; strong?: boolean }) {
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 border-2 border-black px-3 py-2 ${strong ? "text-lg font-bold uppercase" : "font-medium"}`}
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

/** The date range of a record print: a plain GET form, so the range lives in the URL. */
export function DateRangeForm({
  range,
  hidden,
}: {
  range: DayRange;
  /** Other query values to keep when the range changes. */
  hidden?: Record<string, string>;
}) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border bg-background p-3">
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        From
        <Input type="date" name="from" defaultValue={range.from} required className="w-40 text-foreground" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        To
        <Input type="date" name="to" defaultValue={range.to} required className="w-40 text-foreground" />
      </label>
      <Button type="submit" variant="outline" size="sm">
        Show
      </Button>
      <p className="ml-auto text-xs text-muted-foreground">{describeRange(range)}</p>
    </form>
  );
}

/** A plain link above a sheet (screen only). */
export function PrintBackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-sm text-muted-foreground hover:text-foreground hover:underline">
      {children}
    </Link>
  );
}

/** A labelled name-and-date line for a signature on paper. */
export function SignatureLine({ label, name, at }: { label: string; name?: string | null; at?: string }) {
  return (
    <div className="flex min-w-48 flex-1 flex-col gap-0.5 text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-h-6 border-b border-black font-medium">{name ?? ""}</span>
      {at && <span className="text-[11px] text-muted-foreground">{at}</span>}
    </div>
  );
}
