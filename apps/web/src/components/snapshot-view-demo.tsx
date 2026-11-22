"use client";

import type { BiDashboardSpecInput } from "@knotworking/core";
import { SnapshotBody, type FrozenSnapshot } from "@/components/snapshot-view";

/** A frozen snapshot with the change since the previous one, as `/design` shows it (no API calls). */
const spec: BiDashboardSpecInput = {
  sections: [
    {
      id: "s",
      title: "Headline",
      widgets: [
        {
          id: "oee",
          type: "kpi",
          title: "OEE (site)",
          query: { dataset: "certified_metrics", measures: ["oee"], period: { preset: "last_month" } },
          display: { width: 6 },
        },
        {
          id: "ncs",
          type: "kpi",
          title: "Overdue non-conformances",
          query: { dataset: "certified_metrics", measures: ["overdue_nonconformances"] },
          display: { width: 6, goodDirection: "down" },
        },
      ],
    },
  ],
};

const frozen = (asAt: string, oee: number, ncs: number): FrozenSnapshot => ({
  id: asAt,
  title: `Board KPIs, as at ${asAt}`,
  asAt,
  takenAt: `${asAt}T09:00:00Z`,
  catalogueVersion: 3,
  dashboardVersion: 4,
  spec,
  results: {
    widgets: [
      {
        widgetId: "oee",
        status: "ok",
        result: {
          dataset: "certified_metrics",
          columns: [{ key: "oee", label: "OEE (site)", kind: "measure", unit: "percent" }],
          rows: [{ oee }],
          truncated: false,
          period: null,
          comparePeriod: null,
          currency: "GBP",
        },
      },
      {
        widgetId: "ncs",
        status: "ok",
        result: {
          dataset: "certified_metrics",
          columns: [
            {
              key: "overdue_nonconformances",
              label: "Overdue non-conformances",
              kind: "measure",
              unit: "count",
            },
          ],
          rows: [{ overdue_nonconformances: ncs }],
          truncated: false,
          period: null,
          comparePeriod: null,
          currency: "GBP",
        },
      },
    ],
  },
});

export function SnapshotViewDemo() {
  return (
    <SnapshotBody
      snapshot={frozen("2026-11-18", 71.4, 3)}
      previous={frozen("2026-10-20", 68.2, 5)}
      base="/demo"
      workspaceCurrency="GBP"
    />
  );
}
