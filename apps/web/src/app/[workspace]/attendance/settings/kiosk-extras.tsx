"use client";

import { useFormatDateTime } from "@/lib/workspace-time";

import { kioskRejectionLabels } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Input } from "@knotworking/ui/components/input";
import { CloudOff, Printer, QrCode } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { KioskBadgeCard, printKioskBadge } from "@/components/kiosk-badge";
import { StaffNumber } from "@/components/people-badges";
import type { KioskBadgeRow, KioskRejection } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { relativeTime } from "@/lib/relative-time";

const attendance = () => browserApi().v1.workspaces[":slug"].attendance;

const typeLabels: Record<string, string> = {
  clock_in: "Clock-in",
  clock_out: "Clock-out",
  visitor_in: "Visitor sign-in",
  visitor_out: "Visitor sign-out",
};

/**
 * Kiosk badges: a printable QR code per person. The code is shown once, when the badge is
 * issued, for printing; a lost badge or a reprint is a new badge, and the old one stops working.
 */
export function KioskBadges({
  slug,
  workspaceName,
  people,
}: {
  slug: string;
  workspaceName: string;
  people: KioskBadgeRow[];
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [issued, setIssued] = useState<{ name: string; code: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const shown = people.filter((p) =>
    `${p.staff.firstName} ${p.staff.lastName} ${p.staff.staffNumber} ${p.staff.department ?? ""}`
      .toLowerCase()
      .includes(q.trim().toLowerCase()),
  );

  async function issue(row: KioskBadgeRow) {
    setPending(row.staff.id);
    try {
      const res = await unwrap(
        attendance().badges.$post({ param: { slug }, json: { staffId: row.staff.id } }),
      );
      setIssued({ name: `${res.staff.firstName} ${res.staff.lastName}`, code: res.code });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  async function revoke(row: KioskBadgeRow) {
    if (!row.badge) return;
    setPending(row.staff.id);
    try {
      await unwrap(attendance().badges[":id"].$delete({ param: { slug, id: row.badge.id } }));
      toast.success(`${row.staff.firstName}'s badge no longer works`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-medium">Badges</h3>
      {people.length > 8 && (
        <Input
          aria-label="Find a person"
          placeholder="Find a person"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-xs"
        />
      )}
      <Card className="py-0">
        {shown.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No active staff.</p>
        ) : (
          <ul className="max-h-96 divide-y overflow-y-auto text-sm">
            {shown.map((row) => (
              <li
                key={row.staff.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {row.staff.firstName} {row.staff.lastName}
                  </span>
                  <StaffNumber value={row.staff.staffNumber} />
                  {row.badge ? (
                    <span className="text-xs text-muted-foreground">
                      Badge …{row.badge.hint}, issued {formatLongDate(row.badge.issuedAt)}
                      {row.badge.lastUsedAt && ` · used ${relativeTime(row.badge.lastUsedAt)}`}
                    </span>
                  ) : (
                    <Badge variant="outline" className="border-dashed text-muted-foreground">
                      No badge
                    </Badge>
                  )}
                </span>
                <span className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending === row.staff.id}
                    onClick={() => issue(row)}
                  >
                    <QrCode data-icon="inline-start" />
                    {row.badge ? "Replace" : "Issue badge"}
                  </Button>
                  {row.badge && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={pending === row.staff.id}
                      onClick={() => revoke(row)}
                    >
                      Revoke
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {issued && (
        <Dialog open onOpenChange={(o) => !o && setIssued(null)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Badge for {issued.name}</DialogTitle>
              <DialogDescription>
                Print it now: the code isn't shown again. Any earlier badge for this person no longer works.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-center py-2">
              <KioskBadgeCard name={issued.name} workspaceName={workspaceName} code={issued.code} />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={async () => {
                  if (!(await printKioskBadge({ ...issued, workspaceName }))) {
                    toast.error("Allow pop-ups for this site to print the badge");
                  }
                }}
              >
                <Printer data-icon="inline-start" /> Print
              </Button>
              <Button onClick={() => setIssued(null)}>Done</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

/**
 * Entries a kiosk saved while offline that the server refused when it sent them (a wrong PIN,
 * older than the replay window, contradicting the clock events already recorded). Add the
 * missed event by hand on the Shifts page if it was real, then dismiss it.
 */
export function RefusedKioskEvents({ slug, rejections }: { slug: string; rejections: KioskRejection[] }) {
  // Times in the workspace's time zone, the same on the server render and in the browser.
  const dateTime = useFormatDateTime();
  const router = useRouter();
  if (rejections.length === 0) return null;
  async function dismiss(id: string) {
    try {
      await unwrap(attendance()["kiosk-rejections"][":id"].dismiss.$post({ param: { slug, id } }));
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  return (
    <section className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 font-medium">
        <CloudOff className="size-4" /> Refused offline entries ({rejections.length})
      </h3>
      <Card className="py-0">
        <ul className="divide-y text-sm">
          {rejections.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
              <span className="flex min-w-0 flex-col">
                <span>
                  <span className="font-medium">{typeLabels[r.type] ?? r.type}</span>
                  {" · "}
                  {r.staff ? (
                    <>
                      {r.staff.firstName} {r.staff.lastName}{" "}
                      {r.staff.staffNumber && <StaffNumber value={r.staff.staffNumber} />}
                    </>
                  ) : (
                    (r.detail ?? "Unknown")
                  )}
                  {" · "}
                  <span className="tabular-nums">{dateTime(r.at)}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {kioskRejectionLabels[r.code] ?? r.code}
                  {r.message !== kioskRejectionLabels[r.code] && `: ${r.message}`}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => dismiss(r.id)}>
                Dismiss
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
