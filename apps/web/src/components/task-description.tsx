"use client";

import type { DocContent } from "@knotworking/core";
import { browserApi, unwrap } from "@/lib/auth-client";
import { useAutosave } from "@/lib/use-autosave";
import { useWorkspace } from "@/lib/workspace-store";
import { DocEditor } from "./doc-editor/doc-editor";
import { SaveStatusText } from "./doc-editor/save-status";

/**
 * The task page's description: editable with autosave for writers, read-only for
 * guests. Render with `key={taskId}` so pending saves never cross tasks.
 */
export function TaskDescription({
  taskId,
  initial,
}: {
  taskId: string;
  initial: DocContent | null | undefined;
}) {
  const { slug, canEditTasks: canEdit } = useWorkspace();
  const { status, schedule } = useAutosave<{ description: DocContent }>(
    (json) =>
      unwrap(browserApi().v1.workspaces[":slug"].tasks[":id"].$patch({ param: { slug, id: taskId }, json })),
    { errorTitle: "Couldn't save the description" },
  );

  return (
    <div className="relative">
      <DocEditor
        content={initial}
        editable={canEdit}
        placeholder="Add a description… (type '/' for blocks)"
        emptyText="No description"
        onChange={(description) => schedule({ description })}
        images={{ taskId }}
      />
      {canEdit && <SaveStatusText status={status} className="absolute -top-5 right-0" />}
    </div>
  );
}
