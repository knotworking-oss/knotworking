"use client";

import { projectStatusLabels } from "@knotworking/core";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@knotworking/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@knotworking/ui/components/empty";
import { ProjectHealthBadge, ProjectStatusBadge } from "@knotworking/ui/components/project-badges";
import { Progress } from "@knotworking/ui/components/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import Link from "next/link";
import { useMemo } from "react";
import { formatShortDate } from "@/lib/format";
import { noProgress, projectProgress } from "@/lib/projects";
import { useWorkspace } from "@/lib/workspace-store";
import { NewProjectButton, ProjectActions } from "./project-actions";
import { MemberAvatar } from "@/components/member-avatar";

/** Project cards and table, live from the workspace store (edits show instantly). */
export function ProjectsView() {
  const { idx, tasks, slug } = useWorkspace();
  const progress = useMemo(() => projectProgress(tasks, idx), [tasks, idx]);
  const projects = idx.boot.projects;

  if (projects.length === 0) {
    return (
      <Empty className="mt-10">
        <EmptyHeader>
          <EmptyTitle>No projects yet</EmptyTitle>
          <EmptyDescription>
            Projects group tasks from one or more teams under a shared goal.
          </EmptyDescription>
        </EmptyHeader>
        <NewProjectButton />
      </Empty>
    );
  }

  return (
    <>
      <div className="grid gap-4 p-6 sm:grid-cols-2 xl:grid-cols-4">
        {projects.map((p) => {
          const lead = p.leadId ? idx.users.get(p.leadId) : undefined;
          const prog = progress.get(p.id) ?? noProgress;
          const pct = Math.round(prog.ratio * 100);
          return (
            <Card key={p.id} className="transition-shadow hover:shadow-md">
              <CardHeader>
                <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-muted text-lg">
                  {p.icon ?? "◆"}
                </div>
                <CardTitle>
                  <Link href={`/${slug}/projects/${p.id}`} className="hover:underline">
                    {p.name}
                  </Link>
                </CardTitle>
                <CardDescription className="line-clamp-2">{p.description}</CardDescription>
                <CardAction className="flex items-center gap-1">
                  {p.health ? (
                    <ProjectHealthBadge health={p.health} />
                  ) : (
                    <ProjectStatusBadge status={p.status} />
                  )}
                  <ProjectActions project={p} className="-my-1 -mr-2" />
                </CardAction>
              </CardHeader>
              <CardContent className="mt-auto flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {prog.completed}/{prog.total} tasks
                  </span>
                  <span className="tabular-nums">{pct}%</span>
                </div>
                <Progress value={pct} aria-label={`${p.name} progress`} />
              </CardContent>
              <CardFooter className="justify-between border-t text-xs text-muted-foreground">
                <span className="flex items-center gap-2">
                  {lead && <MemberAvatar userId={lead.id} name={lead.name} className="size-5" />}
                  {lead?.name ?? "No lead"}
                </span>
                {p.targetDate && <span>Due {formatShortDate(p.targetDate)}</span>}
              </CardFooter>
            </Card>
          );
        })}
      </div>

      <div className="px-6 pb-10">
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Lead</TableHead>
                <TableHead>Target date</TableHead>
                <TableHead className="w-48 text-right">Progress</TableHead>
                <TableHead className="w-12 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((p) => {
                const lead = p.leadId ? idx.users.get(p.leadId) : undefined;
                const prog = progress.get(p.id) ?? noProgress;
                const pct = Math.round(prog.ratio * 100);
                return (
                  <TableRow key={p.id}>
                    <TableCell className="pl-4 font-medium">
                      <Link href={`/${slug}/projects/${p.id}`} className="hover:underline">
                        <span className="mr-2">{p.icon ?? "◆"}</span>
                        {p.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{projectStatusLabels[p.status]}</TableCell>
                    <TableCell>
                      {lead && (
                        <span className="flex items-center gap-2">
                          <MemberAvatar userId={lead.id} name={lead.name} className="size-5" />
                          {lead.name}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatShortDate(p.targetDate)}</TableCell>
                    <TableCell>
                      <span className="flex items-center justify-end gap-3">
                        <Progress value={pct} className="w-24" aria-label={`${p.name} progress`} />
                        <span className="w-9 text-right text-muted-foreground tabular-nums">{pct}%</span>
                      </span>
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <ProjectActions project={p} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
