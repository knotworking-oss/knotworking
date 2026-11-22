"use client";

import {
  staffDisplayName,
  trainingStatusLabels,
  trainingStatuses,
  type TrainingStatus,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Switch } from "@knotworking/ui/components/switch";
import { ClipboardPlus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { StaffNumber } from "@/components/people-badges";
import { TrainingCell } from "@/components/training-badges";
import type { JobRole, StaffMember, TrainingCourse, TrainingMatrix } from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { RecordTrainingDialog } from "./record-dialog";
import { TrainingNav } from "./training-nav";

const ANY = "__any__";
const shownStatuses = trainingStatuses.filter((s) => s !== "not_required");

interface Filters {
  role?: string | undefined;
  department?: string | undefined;
  status?: TrainingStatus | undefined;
  all: boolean;
}

/** Training → the matrix: people down the side, courses across the top. */
export function TrainingMatrixView({
  slug,
  matrix,
  jobRoles,
  departments,
  courses,
  staff,
  filters,
  pendingCount,
}: {
  slug: string;
  matrix: TrainingMatrix;
  jobRoles: JobRole[];
  departments: string[];
  courses: TrainingCourse[];
  staff: StaffMember[];
  filters: Filters;
  pendingCount: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const [recording, setRecording] = useState(false);

  const apply = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    const params = new URLSearchParams();
    if (next.role) params.set("role", next.role);
    if (next.department) params.set("department", next.department);
    if (next.status) params.set("status", next.status);
    if (next.all) params.set("all", "1");
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Training matrix</h2>
        {can("training", "write") && (
          <Button onClick={() => setRecording(true)}>
            <ClipboardPlus data-icon="inline-start" /> Record training
          </Button>
        )}
      </div>
      <TrainingNav slug={slug} pendingCount={pendingCount} />

      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Job role"
          value={filters.role}
          onChange={(role) => apply({ role })}
          options={jobRoles.filter((r) => r.status === "active").map((r) => [r.id, r.name])}
        />
        <FilterSelect
          label="Department"
          value={filters.department}
          onChange={(department) => apply({ department })}
          options={departments.map((d) => [d, d])}
        />
        <FilterSelect
          label="Status"
          value={filters.status}
          onChange={(status) => apply({ status: status as TrainingStatus | undefined })}
          options={shownStatuses.map((s) => [s, trainingStatusLabels[s]])}
        />
        <label className="ml-1 flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={filters.all} onCheckedChange={(all) => apply({ all })} />
          Every course
        </label>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {shownStatuses.map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <TrainingCell status={s} /> {trainingStatusLabels[s]}{" "}
            <span className="text-muted-foreground tabular-nums">
              {matrix.summary[s as keyof typeof matrix.summary]}
            </span>
          </span>
        ))}
      </div>

      {matrix.rows.length === 0 || matrix.courses.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {courses.length === 0
            ? "No courses yet. Add courses, and say which job roles need them, on the Courses tab."
            : "Nothing to show for these filters."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b">
                <th className="sticky left-0 z-10 bg-card px-4 py-2 text-left font-medium max-md:px-3">
                  Person
                </th>
                {matrix.courses.map((c) => (
                  <th key={c.id} className="px-2 py-2 text-center font-medium" title={c.title}>
                    <span className="block font-mono text-xs">{c.code}</span>
                    <span className="block max-w-28 truncate text-xs font-normal text-muted-foreground">
                      {c.title}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((row) => (
                <tr key={row.staff.id} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="sticky left-0 z-10 bg-card px-4 py-2 max-md:w-32 max-md:min-w-32 max-md:px-3">
                    <Link
                      href={`/${slug}/training/staff/${row.staff.id}`}
                      className="font-medium hover:underline"
                    >
                      {staffDisplayName(row.staff)}
                    </Link>
                    <span className="ml-2 text-xs text-muted-foreground max-md:hidden">
                      <StaffNumber value={row.staff.staffNumber} />
                    </span>
                    {row.staff.jobRoles.length > 0 && (
                      <span className="block text-xs text-muted-foreground max-md:hidden">
                        {row.staff.jobRoles.map((r) => r.name).join(", ")}
                      </span>
                    )}
                  </td>
                  {matrix.courses.map((c) => {
                    const cell = row.cells[c.id];
                    return (
                      <td key={c.id} className="px-2 py-2 text-center">
                        {cell && cell.status !== "not_required" ? (
                          <TrainingCell
                            status={cell.status}
                            overdue={cell.overdue}
                            title={cellDetail(cell)}
                          />
                        ) : (
                          <span className="text-muted-foreground/40">·</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {recording && (
        <RecordTrainingDialog
          slug={slug}
          courses={courses}
          staff={staff}
          onClose={() => setRecording(false)}
        />
      )}
    </div>
  );
}

function cellDetail(cell: TrainingMatrix["rows"][number]["cells"][string]) {
  if (cell.status === "missing") return cell.dueOn ? `due ${formatLongDate(cell.dueOn)}` : "required";
  const parts = [cell.completedOn && `trained ${formatLongDate(cell.completedOn)}`];
  if (cell.expiresOn) parts.push(`expires ${formatLongDate(cell.expiresOn)}`);
  return parts.filter(Boolean).join(", ");
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: [string, string][];
}) {
  if (options.length === 0) return null;
  return (
    <Select value={value ?? ANY} onValueChange={(v) => onChange(v === ANY ? undefined : v)}>
      <SelectTrigger aria-label={label} className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={ANY}>Any {label.toLowerCase()}</SelectItem>
          {options.map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
