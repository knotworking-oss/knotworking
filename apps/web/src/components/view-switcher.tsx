"use client";

import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import { CalendarDays, ChartGantt, Kanban, List } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Updates one query parameter (null removes it), keeping the others. */
export function useSearchParam() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (name: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(name);
    else next.set(name, value);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
}

export type TaskView = "list" | "board" | "calendar" | "timeline";

/** Task views share list, board and calendar. Projects also include a timeline. */
export function ViewSwitcher({
  view,
  timeline,
  explicitDefault,
}: {
  view: TaskView;
  timeline?: boolean;
  explicitDefault?: boolean;
}) {
  const setParam = useSearchParam();
  return (
    <Tabs value={view} onValueChange={(v) => setParam("view", !explicitDefault && v === "list" ? null : v)}>
      <TabsList>
        <TabsTrigger value="list">
          <List /> <span className="max-lg:sr-only">List</span>
        </TabsTrigger>
        <TabsTrigger value="board">
          <Kanban /> <span className="max-lg:sr-only">Board</span>
        </TabsTrigger>
        <TabsTrigger value="calendar">
          <CalendarDays /> <span className="max-lg:sr-only">Calendar</span>
        </TabsTrigger>
        {timeline && (
          <TabsTrigger value="timeline">
            <ChartGantt /> <span className="max-lg:sr-only">Timeline</span>
          </TabsTrigger>
        )}
      </TabsList>
    </Tabs>
  );
}
