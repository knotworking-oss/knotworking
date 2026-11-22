"use client";

import {
  auditIntervalLabel,
  auditProgrammeIntervals,
  auditWeekdayLabels,
  auditWeekdays,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import type { AuditProgrammeRow } from "@/lib/api";
import { errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceToday } from "@/lib/workspace-time";
import {
  DateField,
  MemberSelect,
  NONE,
  orNull,
  qualityApi,
  TextField,
  type MemberOption,
} from "../quality-forms";

/**
 * The recurring audit programme: an area or standard audited every so many months. The server
 * plans each next audit ahead (about two months before it is due) as an ordinary planned audit.
 */
export function AuditProgrammes({
  slug,
  programmes,
  members,
}: {
  slug: string;
  programmes: AuditProgrammeRow[];
  members: MemberOption[];
}) {
  const router = useRouter();
  const { can } = useWorkspace();
  const [adding, setAdding] = useState(false);
  const canWrite = can("quality", "write");
  async function act(run: () => Promise<unknown>, done: string) {
    try {
      await run();
      toast.success(done);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit programme</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {programmes.length === 0 && <p className="text-sm text-muted-foreground">No recurring audits yet.</p>}
        {programmes.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
            <div className="min-w-0">
              <div className="font-medium">
                {p.title}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  {auditIntervalLabel(p.intervalMonths)}
                </span>
              </div>
              {p.scope && <div className="line-clamp-1 text-xs text-muted-foreground">{p.scope}</div>}
              <div className="text-xs text-muted-foreground">
                {p.active ? `Next to plan: ${formatLongDate(p.nextAuditOn)}` : "Paused"}
                {p.weekday ? ` · Always a ${auditWeekdayLabels[p.weekday]}` : ""}
                {p.auditor ? ` · ${p.auditor.name}` : p.auditorName ? ` · ${p.auditorName}` : ""}
              </div>
            </div>
            {canWrite && (
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    act(
                      () =>
                        unwrap(
                          qualityApi()["audit-programmes"][":id"].$patch({
                            param: { slug, id: p.id },
                            json: { active: !p.active },
                          }),
                        ),
                      p.active ? "Paused" : "Resumed",
                    )
                  }
                >
                  {p.active ? "Pause" : "Resume"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${p.title}`}
                  onClick={() => {
                    if (!window.confirm(`Remove the programme ${p.title}? Audits already planned stay.`))
                      return;
                    void act(
                      () =>
                        unwrap(
                          qualityApi()["audit-programmes"][":id"].$delete({ param: { slug, id: p.id } }),
                        ),
                      "Programme removed",
                    );
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            )}
          </div>
        ))}
        {canWrite && (
          <div>
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus data-icon="inline-start" /> Add to the programme
            </Button>
          </div>
        )}
      </CardContent>
      {adding && <AddDialog slug={slug} members={members} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function AddDialog({
  slug,
  members,
  onClose,
}: {
  slug: string;
  members: MemberOption[];
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState("");
  const [interval, setInterval] = useState("12");
  const [first, setFirst] = useState(today);
  const [weekday, setWeekday] = useState(NONE);
  const [auditor, setAuditor] = useState(NONE);
  return (
    <HaccpDialog
      title="Add to the audit programme"
      description="The first audit is planned for the date below; later ones follow at the interval."
      submitLabel="Add"
      disabled={!title.trim()}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          qualityApi()["audit-programmes"].$post({
            param: { slug },
            json: {
              title: title.trim(),
              scope: orNull(scope),
              intervalMonths: Number(interval),
              nextPlannedOn: first,
              weekday: weekday === NONE ? null : Number(weekday),
              auditorUserId: auditor === NONE ? null : auditor,
            },
          }),
        );
        return "Added to the programme";
      }}
    >
      <TextField
        id="p-title"
        label="Area or standard"
        required
        rows={1}
        maxLength={200}
        value={title}
        onChange={setTitle}
      />
      <TextField
        id="p-scope"
        label="Scope"
        rows={2}
        value={scope}
        onChange={setScope}
        placeholder="e.g. BRCGS clause 4.11"
      />
      <SelectField
        id="p-interval"
        label="How often"
        value={interval}
        onChange={setInterval}
        options={auditProgrammeIntervals.map((m) => [String(m), auditIntervalLabel(m)] as const)}
      />
      <DateField id="p-first" label="First audit" value={first} onChange={setFirst} />
      <SelectField
        id="p-weekday"
        label="Day of the week"
        value={weekday}
        onChange={setWeekday}
        description="Pin each audit to a weekday: the first such day on or after its date. Any day leaves the dates as they fall."
        options={[
          [NONE, "Any day"],
          ...auditWeekdays.map((d) => [String(d), auditWeekdayLabels[d]!] as const),
        ]}
      />
      <MemberSelect
        id="p-auditor"
        label="Auditor"
        value={auditor}
        onChange={setAuditor}
        members={members}
        noneLabel="Not chosen yet"
      />
    </HaccpDialog>
  );
}
