"use client";

import { Button } from "@knotworking/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@knotworking/ui/components/dropdown-menu";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useWorkspace, type ProjectRow } from "@/lib/workspace-store";
import { ProjectDialog } from "./project-dialog";

/** "New project" button that opens the create dialog. Hidden for guests. */
export function NewProjectButton({ onCreated }: { onCreated?: (id: string) => void }) {
  const { canEditTasks: canEdit } = useWorkspace();
  const [open, setOpen] = useState(false);
  if (!canEdit) return null;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus /> New project
      </Button>
      {open && <ProjectDialog onClose={() => setOpen(false)} onSaved={onCreated} />}
    </>
  );
}

/**
 * Edit and delete for one project: a "…" menu, the edit dialog and the delete
 * confirmation. Hidden for guests.
 */
export function ProjectActions({
  project,
  onDeleted,
  className,
}: {
  project: ProjectRow;
  /** Called when the server accepts deletion, e.g. to leave the project's page. */
  onDeleted?: () => void;
  className?: string;
}) {
  const { canEditTasks: canEdit, tasks, idx, deleteProject } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (!canEdit) return null;
  const counts = idx.boot.closedWindow?.projectCounts[project.id];
  const taskCount = idx.boot.closedWindow
    ? counts
      ? counts.open + counts.completed + counts.canceled
      : 0
    : tasks.filter((t) => t.projectId === project.id).length;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${project.name}`}
            className={className}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil /> Edit project
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2 /> Delete project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {editing && <ProjectDialog project={project} onClose={() => setEditing(false)} />}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this project?</DialogTitle>
            <DialogDescription>
              &ldquo;{project.name}&rdquo; will be removed for everyone in the workspace.{" "}
              {taskCount > 0
                ? `Its ${taskCount} task${taskCount === 1 ? "" : "s"} will be kept, without a project.`
                : "It has no tasks."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={async () => {
                setConfirming(false);
                if (await deleteProject(project.id)) {
                  onDeleted?.();
                  toast.success("Project deleted", { description: project.name });
                }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
