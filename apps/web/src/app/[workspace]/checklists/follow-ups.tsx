"use client";

import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import Link from "next/link";
import { useState } from "react";
import { checklistApi, SiteDialog, TextAreaField, useDateTime } from "@/components/site-forms";
import type { ChecklistAction } from "@/lib/api";
import { unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

const statusLabels = { open: "Open", resolved: "Resolved", superseded: "Superseded" };

export function ChecklistFollowUps({
  slug,
  actions,
  filterHref,
  showAll,
}: {
  slug: string;
  actions: ChecklistAction[];
  filterHref: string;
  showAll: boolean;
}) {
  const dateTime = useDateTime();
  const { can } = useWorkspace();
  const [selected, setSelected] = useState<ChecklistAction | null>(null);
  const [note, setNote] = useState("");

  return (
    <Card id="follow-ups">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle>Follow-up actions</CardTitle>
        <Button asChild variant="outline" size="sm">
          <Link href={filterHref}>{showAll ? "Open actions" : "All actions"}</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {showAll ? "No follow-up actions yet." : "No open follow-up actions."}
          </p>
        ) : (
          <ul className="divide-y">
            {actions.map((action) => (
              <li key={action.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="space-y-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{action.templateName}</span>
                    <Badge variant="outline">{statusLabels[action.status]}</Badge>
                  </div>
                  <div className="text-muted-foreground">{dateTime(action.performedAt)}</div>
                  {action.failures.map((item) => (
                    <div key={item.id}>
                      {item.prompt}
                      {item.note ? ` · ${item.note}` : ""}
                    </div>
                  ))}
                  {action.resolution && <div className="text-muted-foreground">{action.resolution}</div>}
                </div>
                {action.status === "open" && can("checklists", "write") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSelected(action);
                      setNote("");
                    }}
                  >
                    Resolve
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {selected && (
        <SiteDialog
          title="Resolve follow-up"
          description={selected.templateName}
          submitLabel="Resolve"
          onClose={() => setSelected(null)}
          disabled={!note.trim()}
          onSubmit={async () => {
            await unwrap(
              checklistApi().actions[":id"].resolve.$post({
                param: { slug, id: selected.id },
                json: { note: note.trim() },
              }),
            );
            return "Follow-up resolved";
          }}
        >
          <TextAreaField
            id="follow-up-resolution"
            label="What was done?"
            value={note}
            onChange={setNote}
            required
          />
        </SiteDialog>
      )}
    </Card>
  );
}
