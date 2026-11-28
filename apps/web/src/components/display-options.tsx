"use client";

import { Button } from "@knotworking/ui/components/button";
import { Label } from "@knotworking/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@knotworking/ui/components/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { SlidersHorizontal } from "lucide-react";
import {
  taskDisplayGroups,
  taskViewProperties,
  type TaskDisplayGroup,
  type TaskViewProperty,
} from "@knotworking/core";
import { useSearchParams } from "next/navigation";
import {
  taskOrderings,
  orderingLabels,
  parseTaskGroup,
  taskGroupLabels,
  type TaskOrdering,
} from "@/lib/model";
import { useSearchParam } from "./view-switcher";
import { defaultBoardProperties, parseTaskProperties, taskPropertyLabels } from "@/lib/task-view-properties";

/** "Display" menu for task views. Settings live in the URL so views can be shared. */
export function DisplayOptions({
  ordering,
  explicitDefault,
  defaultGroup,
  layout = "list",
  defaultProperties,
  defaultSubgroup,
}: {
  ordering: TaskOrdering;
  explicitDefault?: boolean;
  defaultGroup?: TaskDisplayGroup;
  layout?: "list" | "board" | "calendar";
  defaultProperties?: readonly TaskViewProperty[];
  defaultSubgroup?: TaskDisplayGroup | null;
}) {
  const setParam = useSearchParam();
  const params = useSearchParams();
  const group = parseTaskGroup(params.get("group")) ?? defaultGroup ?? "status";
  const rawSubgroup = params.get("subgroup");
  const subgroup = rawSubgroup === "none" ? null : (parseTaskGroup(rawSubgroup) ?? defaultSubgroup);
  const properties =
    parseTaskProperties(params.get("properties")) ??
    defaultProperties ??
    (layout === "board" ? defaultBoardProperties : taskViewProperties);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm">
          <SlidersHorizontal /> <span className="max-lg:sr-only">Display</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="display-ordering" className="font-normal text-muted-foreground">
            Ordering
          </Label>
          <Select
            value={ordering}
            onValueChange={(v) => setParam("order", !explicitDefault && v === "priority" ? null : v)}
          >
            <SelectTrigger id="display-ordering" size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {taskOrderings.map((o) => (
                <SelectItem key={o} value={o}>
                  {orderingLabels[o]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="display-group" className="font-normal text-muted-foreground">
            Group by
          </Label>
          <Select
            value={group}
            onValueChange={(next) => setParam("group", next === "status" && !explicitDefault ? null : next)}
          >
            <SelectTrigger id="display-group" size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {taskDisplayGroups.map((field) => (
                <SelectItem key={field} value={field}>
                  {taskGroupLabels[field]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {layout !== "calendar" && (
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="display-subgroup" className="font-normal text-muted-foreground">
              Subgroup by
            </Label>
            <Select
              value={subgroup && subgroup !== group ? subgroup : "none"}
              onValueChange={(next) =>
                setParam("subgroup", next === "none" && !defaultSubgroup ? null : next)
              }
            >
              <SelectTrigger id="display-subgroup" size="sm" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {taskDisplayGroups
                  .filter((field) => field !== group)
                  .map((field) => (
                    <SelectItem key={field} value={field}>
                      {taskGroupLabels[field]}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {layout !== "calendar" && (
          <fieldset className="grid grid-cols-2 gap-x-3 gap-y-2 border-t pt-2 text-xs">
            <legend className="pr-2 text-muted-foreground">Visible properties</legend>
            {taskViewProperties.map((property) => (
              <label key={property} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={properties.includes(property)}
                  onChange={(event) => {
                    const next = taskViewProperties.filter((key) =>
                      key === property ? event.target.checked : properties.includes(key),
                    );
                    setParam("properties", next.join(","));
                  }}
                />
                {taskPropertyLabels[property]}
              </label>
            ))}
            {params.has("properties") && (
              <Button
                variant="ghost"
                size="xs"
                className="col-span-2 justify-start"
                onClick={() => setParam("properties", null)}
              >
                Reset visible properties
              </Button>
            )}
          </fieldset>
        )}
        <p className="text-xs text-muted-foreground">
          {group === "labelIds"
            ? "Dragging rearranges tasks within each label group."
            : group !== "status"
              ? "Dragging between groups changes the grouped property."
              : ordering === "manual"
                ? "Drag tasks to arrange them."
                : ordering === "priority"
                  ? "Dragging a task between others gives it their priority."
                  : "Drag tasks between groups to change their status."}
        </p>
      </PopoverContent>
    </Popover>
  );
}
