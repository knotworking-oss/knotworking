"use client";

import { staffDisplayName } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { Spinner } from "@knotworking/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { BadgeCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { stackedTable } from "@/components/stacked-table";
import { StaffNumber } from "@/components/people-badges";
import type { TrainingRecord } from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { signOff, VoidRecordDialog } from "../record-actions";

/** The sign-off queue: tick people and sign them off together, or void a record made in error. */
export function SignOffList({ slug, records }: { slug: string; records: TrainingRecord[] }) {
  const router = useRouter();
  const { viewer } = useWorkspace();
  // Your own training needs someone else's sign-off.
  const own = (r: TrainingRecord) => r.staff.userId === viewer.id;
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [voiding, setVoiding] = useState<TrainingRecord | null>(null);

  if (records.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        Nothing is waiting for a sign-off.
      </p>
    );
  }

  const toggle = (id: string, on: boolean) =>
    setChosen((ids) => {
      const next = new Set(ids);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const all = records.filter((r) => !own(r)).map((r) => r.id);

  async function signChosen(ids: string[]) {
    setPending(true);
    const ok = await signOff(slug, ids);
    setPending(false);
    if (ok) {
      setChosen(new Set());
      router.refresh();
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={
              chosen.size > 0 && chosen.size === all.length ? true : chosen.size > 0 ? "indeterminate" : false
            }
            onCheckedChange={(on) => setChosen(new Set(on ? all : []))}
          />
          Select all
        </label>
        <Button disabled={pending || chosen.size === 0} onClick={() => signChosen([...chosen])}>
          {pending ? <Spinner data-icon="inline-start" /> : <BadgeCheck data-icon="inline-start" />}
          Sign off {chosen.size || ""} as competent
        </Button>
      </div>
      <Card className="overflow-x-auto py-0">
        <Table className={stackedTable}>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 pl-4" />
              <TableHead>Person</TableHead>
              <TableHead>Course</TableHead>
              <TableHead>Trained</TableHead>
              <TableHead>Trainer</TableHead>
              <TableHead className="pr-4" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="pl-4" data-select>
                  <Checkbox
                    aria-label={`Choose ${staffDisplayName(r.staff)}`}
                    disabled={own(r)}
                    title={own(r) ? "Your own training needs someone else's sign-off" : undefined}
                    checked={chosen.has(r.id)}
                    onCheckedChange={(on) => toggle(r.id, on === true)}
                  />
                </TableCell>
                <TableCell data-primary>
                  <Link
                    href={`/${slug}/training/staff/${r.staff.id}`}
                    className="font-medium hover:underline"
                  >
                    {staffDisplayName(r.staff)}
                  </Link>
                  <span className="ml-2 text-xs text-muted-foreground">
                    <StaffNumber value={r.staff.staffNumber} />
                  </span>
                </TableCell>
                <TableCell data-label="Course" data-block>
                  <span className="font-mono text-xs">{r.course.code}</span> {r.course.title}
                  {r.sopVersionNumber && (
                    <span className="ml-1 text-xs text-muted-foreground">(v{r.sopVersionNumber})</span>
                  )}
                </TableCell>
                <TableCell data-label="Trained">{formatLongDate(r.completedOn)}</TableCell>
                <TableCell data-label="Trainer">{r.trainer ?? "—"}</TableCell>
                <TableCell className="pr-4 text-right" data-actions>
                  <Button variant="ghost" size="sm" onClick={() => setVoiding(r)}>
                    Void
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      {voiding && (
        <VoidRecordDialog
          slug={slug}
          recordId={voiding.id}
          summary={`${staffDisplayName(voiding.staff)}, ${voiding.course.code} on ${formatLongDate(voiding.completedOn)}`}
          onClose={() => setVoiding(null)}
        />
      )}
    </>
  );
}
