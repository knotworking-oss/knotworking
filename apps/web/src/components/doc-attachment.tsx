"use client";

import { PropertyMenu, type PropertyOption } from "@knotworking/ui/components/property-menu";
import { cn } from "@knotworking/ui/lib/utils";
import { ChevronDown, FolderKanban, Users } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { resolveAttachment } from "@/lib/doc-attachments";
import { useWorkspace } from "@/lib/workspace-store";

const NONE = "__none__";

const chip =
  "inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs transition-colors";
const hover = "hover:bg-muted data-[state=open]:bg-muted";

/**
 * One attachment (team or project) as a small chip. Attached: the name links to its page and, for
 * writers, a caret opens the picker (which also detaches). Unattached: writers get a dashed
 * "attach" chip that opens the picker; guests see nothing.
 */
function AttachChip({
  kind,
  target,
  options,
  onChange,
  editable,
}: {
  kind: "team" | "project";
  target: { id: string; name: string; icon: string | null; href: string } | undefined;
  options: PropertyOption[];
  onChange: (id: string | null) => void;
  editable: boolean;
}) {
  const Icon = kind === "team" ? Users : FolderKanban;
  const icon = <span className="shrink-0">{target?.icon ?? <Icon className="size-3.5" />}</span>;
  const picker = (trigger: ReactNode) => (
    <PropertyMenu
      options={options}
      value={target?.id ?? NONE}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
      placeholder={`Attach to ${kind}…`}
      emptyText={kind === "team" ? "No teams" : "No projects"}
    >
      {trigger}
    </PropertyMenu>
  );

  if (!target) {
    if (!editable) return null;
    return picker(
      <button
        type="button"
        aria-label={`Attach to a ${kind}`}
        className={cn(chip, hover, "border-dashed text-muted-foreground")}
      >
        {icon}
        <span className="capitalize">{kind}</span>
      </button>,
    );
  }

  return (
    <span className={cn(chip, "gap-0 p-0")}>
      <Link
        href={target.href}
        aria-label={`${kind === "team" ? "Team" : "Project"}: ${target.name}`}
        className="inline-flex h-full min-w-0 items-center gap-1.5 rounded-l-md pr-1.5 pl-2 hover:bg-muted"
      >
        {icon}
        <span className="truncate">{target.name}</span>
      </Link>
      {editable &&
        picker(
          <button
            type="button"
            aria-label={`Change ${kind} (currently ${target.name})`}
            className={cn(
              "inline-flex h-full items-center rounded-r-md border-l px-1 text-muted-foreground",
              hover,
            )}
          >
            <ChevronDown className="size-3" />
          </button>,
        )}
    </span>
  );
}

/**
 * Where a doc is attached: a small chip for its team and one for its project, each linking to that page.
 * Writers can attach, change or clear either; guests see the chips only. Reads the doc from the workspace
 * store (so it follows the optimistic edit), falling back to what the server rendered.
 */
export function DocAttachment({
  id,
  initial,
}: {
  id: string;
  initial: { teamId: string | null; projectId: string | null };
}) {
  const { idx, slug, canEditDocs: canEdit, attachDocument } = useWorkspace();
  const doc = idx.boot.documents.find((d) => d.id === id) ?? initial;
  const { team, project } = resolveAttachment(doc, idx);

  if (!canEdit && !team && !project) return null;

  const teamOptions: PropertyOption[] = [
    { value: NONE, label: "No team" },
    ...idx.boot.teams.map((t) => ({
      value: t.id,
      label: t.name,
      icon: <span className="w-4 text-center">{t.icon ?? <Users className="size-3.5" />}</span>,
    })),
  ];
  const projectOptions: PropertyOption[] = [
    { value: NONE, label: "No project" },
    ...idx.boot.projects.map((p) => ({
      value: p.id,
      label: p.name,
      icon: <span className="w-4 text-center">{p.icon ?? "◆"}</span>,
    })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Attached to">
      <AttachChip
        kind="team"
        editable={canEdit}
        options={teamOptions}
        target={
          team && { id: team.id, name: team.name, icon: team.icon ?? null, href: `/${slug}/team/${team.key}` }
        }
        onChange={(teamId) => void attachDocument(id, { teamId })}
      />
      <AttachChip
        kind="project"
        editable={canEdit}
        options={projectOptions}
        target={
          project && {
            id: project.id,
            name: project.name,
            icon: project.icon ?? null,
            href: `/${slug}/projects/${project.id}`,
          }
        }
        onChange={(projectId) => void attachDocument(id, { projectId })}
      />
    </div>
  );
}
