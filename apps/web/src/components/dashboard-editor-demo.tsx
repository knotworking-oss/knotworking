"use client";

import {
  biAddWidget,
  biDatasets,
  biEmptySpec,
  biNewWidget,
  biRestrictCatalogue,
  type BiWidget,
} from "@knotworking/core";
import { useMemo, useState } from "react";
import { IssueList, SpecJson, WidgetEditor } from "@/components/dashboard-editor";

/** The builder's widget form over a sample catalogue, as `/design` shows it (no API calls). */
export function DashboardEditorDemo() {
  const catalogue = useMemo(
    () =>
      biRestrictCatalogue(
        biDatasets,
        biDatasets
          .filter((d) => ["quality_complaints", "purchase_orders"].includes(d.id))
          .map((d) => ({ id: d.id, dimensions: d.dimensions, measures: d.measures })),
      ),
    [],
  );
  const spec = useMemo(() => biEmptySpec(), []);
  const [widget, setWidget] = useState<BiWidget>(() => {
    const base = biNewWidget(
      spec,
      "bar",
      catalogue.find((d) => d.id === "quality_complaints"),
    );
    return base.type === "text"
      ? base
      : {
          ...base,
          title: "Complaints by category",
          query: { ...base.query, groupBy: [{ dim: "category" }] },
        };
  });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="rounded-lg border p-4">
        <WidgetEditor
          widget={widget}
          spec={biAddWidget(spec, "main", widget)}
          catalogue={catalogue}
          onChange={setWidget}
          loadChoices={async () => [
            { value: "a", label: "Millers Ltd" },
            { value: "b", label: "Sweet Co" },
          ]}
        />
      </div>
      <div className="flex flex-col gap-4">
        <IssueList
          issues={[
            {
              path: "query.groupBy[0].dim",
              message: "unknown dimension 'catgory'; did you mean 'category'?",
              suggestion: "category",
            },
          ]}
        />
        <SpecJson value={widget} />
      </div>
    </div>
  );
}
