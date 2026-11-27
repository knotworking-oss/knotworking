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
import { taskOrderings, orderingLabels, type TaskOrdering } from "@/lib/model";
import { useSearchParam } from "./view-switcher";

/** "Display" menu for task views. Settings live in the URL so views can be shared. */
export function DisplayOptions({
  ordering,
  explicitDefault,
}: {
  ordering: TaskOrdering;
  explicitDefault?: boolean;
}) {
  const setParam = useSearchParam();
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
        <p className="text-xs text-muted-foreground">
          {ordering === "manual"
            ? "Drag tasks to arrange them."
            : ordering === "priority"
              ? "Dragging a task between others gives it their priority."
              : "Drag tasks between groups to change their status."}
        </p>
      </PopoverContent>
    </Popover>
  );
}
