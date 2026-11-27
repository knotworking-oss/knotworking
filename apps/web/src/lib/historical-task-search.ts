"use client";

import { olderClosedTaskFilter } from "@knotworking/core";
import { useEffect, useState } from "react";
import type { TaskSummary } from "./api";
import { browserApi, unwrap } from "./auth-client";
import { SEARCH_DEBOUNCE_MS } from "./content-search";
import { useWorkspace } from "./workspace-store";

/** Find titles that are outside the browser's recent-task snapshot. */
export function useHistoricalTaskSearch(raw: string, enabled = true) {
  const { idx, slug } = useWorkspace();
  const cutoff = idx.boot.closedWindow?.cutoff;
  const available = !!idx.boot.closedWindow?.olderCount;
  const title = raw.trim().slice(0, 200);
  const active = enabled && available && !!cutoff && title.length >= 2;
  const [settled, setSettled] = useState<{ key: string; tasks: TaskSummary[] }>();
  const key = JSON.stringify([slug, cutoff, title]);

  useEffect(() => {
    if (!active || !cutoff) return;
    let canceled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await unwrap(
          browserApi().v1.workspaces[":slug"].tasks.$get({
            param: { slug },
            query: {
              title,
              limit: "20",
              sort: "updated",
              filter: JSON.stringify({ version: 1, expression: olderClosedTaskFilter(cutoff) }),
            },
          }),
        );
        if (!canceled) setSettled({ key, tasks: result.tasks });
      } catch {
        if (!canceled) setSettled({ key, tasks: [] });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [active, cutoff, key, slug, title]);
  return active && settled?.key === key ? settled.tasks : [];
}
