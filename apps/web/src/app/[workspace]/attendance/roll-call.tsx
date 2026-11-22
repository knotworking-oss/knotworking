"use client";

import { rollCallStatuses, type RollCallStatus } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { ToggleGroup, ToggleGroupItem } from "@knotworking/ui/components/toggle-group";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { RollCall } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

const statusLabels: Record<RollCallStatus, string> = {
  unaccounted: "Not yet",
  safe: "Safe",
  missing: "Missing",
};

/** A roll call: tick everyone off as safe (or missing), then end it. Read-only once ended. */
export function RollCallView({ slug, call }: { slug: string; call: RollCall }) {
  const router = useRouter();
  // Marks waiting for the server, laid over the latest entries. Everything else comes from the
  // server on each refresh, so two marshals see each other's ticks.
  const [pending, setPending] = useState<Record<string, RollCallStatus>>({});
  const entries = call.entries.map((e) => (e.id in pending ? { ...e, status: pending[e.id]! } : e));
  const [ending, setEnding] = useState(false);
  const open = !call.endedAt;
  const api = () => browserApi().v1.workspaces[":slug"].attendance["roll-calls"][":id"];
  const count = (s: RollCallStatus) => entries.filter((e) => e.status === s).length;
  const settle = (entryId: string) => setPending(({ [entryId]: _done, ...rest }) => rest);

  async function mark(entryId: string, status: RollCallStatus) {
    setPending((p) => ({ ...p, [entryId]: status }));
    try {
      await unwrap(
        api().entries[":entryId"].$post({ param: { slug, id: call.id, entryId }, json: { status } }),
      );
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      settle(entryId);
    }
  }

  // Once the server shows a mark, it no longer needs holding here.
  useEffect(() => {
    setPending((p) => {
      const left = Object.fromEntries(
        Object.entries(p).filter(([id, status]) => call.entries.find((e) => e.id === id)?.status !== status),
      );
      return Object.keys(left).length === Object.keys(p).length ? p : left;
    });
  }, [call.entries]);

  async function end() {
    setEnding(true);
    try {
      await unwrap(api().end.$post({ param: { slug, id: call.id }, json: {} }));
      toast.success("Roll call ended");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setEnding(false);
    }
  }

  return (
    <Card className={open ? "gap-0 border-destructive py-0" : "gap-0 py-0"}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 className="font-semibold">
            {call.kind === "real" ? "Evacuation roll call" : "Fire drill roll call"}
            {open && (
              <Badge variant="destructive" className="ml-2">
                In progress
              </Badge>
            )}
          </h3>
          <p className="text-sm text-muted-foreground">
            {count("safe")} safe · {count("missing")} missing · {count("unaccounted")} not yet accounted for
            {call.startedByName && ` · started by ${call.startedByName}`}
          </p>
        </div>
        {open && (
          <Button variant="outline" disabled={ending} onClick={end}>
            End roll call
          </Button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nobody was on site.</p>
      ) : (
        <ul className="divide-y text-sm">
          {entries.map((e) => (
            <li
              key={e.id}
              className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
            >
              <span className="min-w-0 sm:flex-1">
                <span className="font-medium">{e.name}</span>{" "}
                <span className="text-xs text-muted-foreground">{e.detail}</span>
              </span>
              {open ? (
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  className="max-sm:w-full sm:shrink-0"
                  value={e.status}
                  onValueChange={(v) => v && mark(e.id, v as RollCallStatus)}
                  aria-label={`${e.name}: accounted for?`}
                >
                  {rollCallStatuses.map((s) => (
                    <ToggleGroupItem key={s} value={s} className="max-sm:h-11 max-sm:flex-1">
                      {statusLabels[s]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              ) : (
                <Badge variant={e.status === "missing" ? "destructive" : "outline"}>
                  {statusLabels[e.status]}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
      {call.notes && <p className="border-t px-4 py-2 text-sm text-muted-foreground">Notes: {call.notes}</p>}
    </Card>
  );
}
