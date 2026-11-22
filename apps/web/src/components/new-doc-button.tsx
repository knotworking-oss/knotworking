"use client";

import { newId } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@knotworking/ui/components/tooltip";
import { FilePlus, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { scopeAttachment, type DocScope } from "@/lib/doc-attachments";
import { useWorkspace } from "@/lib/workspace-store";

/**
 * Creates an untitled doc (optionally under `parentId`, or attached to a team or project via `scope`)
 * and opens it. Hidden for guests.
 */
export function NewDocButton({
  parentId,
  subpage = false,
  scope,
  label = "New doc",
}: {
  parentId?: string;
  subpage?: boolean;
  scope?: DocScope;
  label?: string;
}) {
  const { slug, canEditDocs: canEdit } = useWorkspace();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!canEdit) return null;

  const create = async () => {
    setBusy(true);
    const id = newId();
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].documents.$post({
          param: { slug },
          json: { id, parentId: parentId ?? null, title: "", ...(scope ? scopeAttachment(scope) : {}) },
        }),
      );
      router.push(`/${slug}/docs/${id}`);
      router.refresh();
    } catch (err) {
      toast.error("Couldn't create the page", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  if (subpage)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Add a subpage" disabled={busy} onClick={create}>
            <FilePlus />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Add a subpage</TooltipContent>
      </Tooltip>
    );
  return (
    <Button size="sm" disabled={busy} onClick={create}>
      <Plus /> {label}
    </Button>
  );
}
