"use client";

import { actionableDueStates, type SiteProgramme } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import Link from "next/link";
import { useState } from "react";
import { DueStateBadge } from "@/components/haccp-badges";
import { ProgrammeBadge } from "@/components/site-badges";
import type { SiteDue } from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

const pages: Record<SiteProgramme, string> = {
  pest: "pest",
  glass: "glass",
  maintenance: "maintenance",
  storage: "storage",
  checklist: "checks",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What is due across the programmes, most urgent first, and what is waiting for a person:
 * readings to review, checks to sign off, hygiene clearances to give, areas held after a breakage,
 * open corrective actions, damaged or missing glass and pest activity on the last visit.
 */
export function DueBoard({ slug, due }: { slug: string; due: SiteDue }) {
  const timeZone = useWorkspaceTimeZone();
  const { can } = useWorkspace();
  const canManage = can("site", "manage");
  const [showAll, setShowAll] = useState(false);
  const base = `/${slug}/site`;
  const items = showAll
    ? due.items
    : due.items.filter((i) => (actionableDueStates as readonly string[]).includes(i.state));
  const { counts } = due;
  const waiting = [
    { n: counts.awaitingReview, text: "storage readings to review", href: `${base}/storage`, manage: true },
    {
      n: counts.awaitingSignOff,
      text: "checks to sign off before production",
      href: `${base}/checks`,
      manage: true,
    },
    {
      n: counts.awaitingClearance,
      text: "hygiene clearances to give after maintenance",
      href: `${base}/maintenance`,
      manage: true,
    },
    {
      n: counts.openBreakages,
      text: "areas held after a glass breakage",
      href: `${base}/glass`,
      manage: true,
    },
    { n: counts.openActions, text: "open corrective actions", href: `${base}/storage`, manage: false },
    { n: counts.glassProblems, text: "damaged or missing glass items", href: `${base}/glass`, manage: false },
    {
      n: counts.pestActivity,
      text: "pest findings with moderate or high activity on the last visit",
      href: `${base}/pest`,
      manage: false,
    },
  ].filter((w) => w.n > 0 && (!w.manage || canManage));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">What&apos;s due</h2>
          <p className="text-sm text-muted-foreground">
            {plural(counts.overdue, "item")} overdue, {counts.due} due
          </p>
        </div>
        <Button variant="outline" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Only what is due" : "Show everything"}
        </Button>
      </div>

      {waiting.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Waiting for a person</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 text-sm">
              {waiting.map((w) => (
                <li key={w.text}>
                  <Link className="underline-offset-2 hover:underline" href={w.href}>
                    <span className="font-medium tabular-nums">{w.n}</span> {w.text}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card className="py-0">
        <CardContent className="overflow-x-auto px-0 py-2">
          {items.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              {showAll
                ? "Nothing is scheduled yet. Add devices, units, tasks and checklists on each page."
                : "Nothing is due."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Programme</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>Where</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="pr-4">Last done</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={`${item.programme}:${item.subjectId}`}>
                    <TableCell className="pl-4">
                      <Link href={`${base}/${pages[item.programme]}`}>
                        <ProgrammeBadge programme={item.programme} />
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{item.title}</div>
                      {item.note && <div className="text-xs text-muted-foreground">{item.note}</div>}
                    </TableCell>
                    <TableCell>{item.where ?? "—"}</TableCell>
                    <TableCell>
                      <DueStateBadge state={item.state} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {item.dueOn ? formatLongDate(item.dueOn) : item.reason ? "Not set" : "Now"}
                    </TableCell>
                    <TableCell className="pr-4 whitespace-nowrap">
                      {item.lastAt ? formatLongDate(item.lastAt, timeZone) : "Never"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
