"use client";

import { timeReportGroupBys, type TimeReportGroupBy } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Label } from "@knotworking/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@knotworking/ui/components/toggle-group";
import { Download } from "lucide-react";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";
import {
  groupByLabels,
  presetRange,
  reportPresetLabels,
  reportPresets,
  type ReportFilters,
  type ReportPreset,
} from "@/lib/time-report";

export interface ReportOption {
  id: string;
  name: string;
}

export interface ReportOptions {
  projects: ReportOption[];
  teams: ReportOption[];
  people: ReportOption[];
}

/** Stands for "no filter" in a Select (an item can't have an empty value). */
const ALL = "__all__";

/**
 * Filters of the time report: date preset (or custom dates), project, team, person, grouping, and
 * the CSV export. Controlled and presentational: the page wires `onChange` to the URL.
 */
export function TimeReportFilters({
  filters,
  options,
  onChange,
  exportHref,
  today = new Date(),
  timeZone,
}: {
  filters: ReportFilters;
  options: ReportOptions;
  onChange: (next: ReportFilters) => void;
  /** Download URL of the CSV for the current filters. */
  exportHref: string;
  /** Used to fill the custom dates when switching to "Custom". */
  today?: Date;
  /** The zone presets are worked out in (default: the workspace's). */
  timeZone?: string;
}) {
  const workspaceZone = useWorkspaceTimeZone();
  const pick = (
    label: string,
    value: string | undefined,
    items: ReportOption[],
    set: (id: string | undefined) => void,
    allLabel: string,
  ) => (
    <div className="flex min-w-40 flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value ?? ALL} onValueChange={(v) => set(v === ALL ? undefined : v)}>
        <SelectTrigger size="sm" className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {items.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const setPreset = (preset: ReportPreset) => {
    // Custom starts from the range that was showing, so the dates are never blank.
    const range =
      preset === "custom"
        ? { from: filters.from, to: filters.to }
        : presetRange(preset, today, timeZone ?? workspaceZone);
    onChange({ ...filters, preset, ...range });
  };
  const setDate = (key: "from" | "to", value: string) => {
    if (!value) return; // a half-typed date: wait for a whole one
    onChange({ ...filters, preset: "custom", [key]: value });
  };

  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3" data-slot="time-report-filters">
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Period</Label>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={filters.preset}
          onValueChange={(v) => v && setPreset(v as ReportPreset)}
          aria-label="Period"
        >
          {reportPresets.map((preset) => (
            <ToggleGroupItem key={preset} value={preset}>
              {reportPresetLabels[preset]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {filters.preset === "custom" && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="report-from" className="text-xs text-muted-foreground">
              From
            </Label>
            <Input
              id="report-from"
              type="date"
              className="h-8 w-40"
              value={filters.from}
              max={filters.to}
              onChange={(e) => setDate("from", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="report-to" className="text-xs text-muted-foreground">
              To
            </Label>
            <Input
              id="report-to"
              type="date"
              className="h-8 w-40"
              value={filters.to}
              min={filters.from}
              onChange={(e) => setDate("to", e.target.value)}
            />
          </div>
        </>
      )}

      {pick(
        "Project",
        filters.projectId,
        options.projects,
        (projectId) => onChange({ ...filters, projectId }),
        "All projects",
      )}
      {pick("Team", filters.teamId, options.teams, (teamId) => onChange({ ...filters, teamId }), "All teams")}
      {pick(
        "Person",
        filters.userId,
        options.people,
        (userId) => onChange({ ...filters, userId }),
        "Everyone",
      )}

      <div className="flex min-w-32 flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Group by</Label>
        <Select
          value={filters.groupBy}
          onValueChange={(groupBy) => onChange({ ...filters, groupBy: groupBy as TimeReportGroupBy })}
        >
          <SelectTrigger size="sm" className="w-full" aria-label="Group by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {timeReportGroupBys.map((g) => (
              <SelectItem key={g} value={g}>
                {groupByLabels[g]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button asChild variant="outline" size="sm" className="ml-auto">
        {/* A plain link: the browser downloads it through the web app's /api proxy with its cookie. */}
        <a href={exportHref} download>
          <Download />
          Export CSV
        </a>
      </Button>
    </div>
  );
}
