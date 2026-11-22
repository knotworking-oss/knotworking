"use client";

import { FileText } from "lucide-react";
import Link from "next/link";
import { docsInScope, type DocScope } from "@/lib/doc-attachments";
import { formatShortDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { NewDocButton } from "./new-doc-button";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

/**
 * The docs attached to a team or project, live from the workspace store, with a "New doc here" button
 * (hidden for guests) that creates a doc already attached. Always shown, so writers can add the first doc.
 */
export function DocsSection({ scope, subject }: { scope: DocScope; subject: string }) {
  const timeZone = useWorkspaceTimeZone();
  const { idx, slug, canEditDocs: canEdit } = useWorkspace();
  const docs = docsInScope(idx.boot.documents, scope);

  // Guests can't add docs, so an empty section would only be noise.
  if (docs.length === 0 && !canEdit) return null;

  return (
    <section aria-labelledby="docs-heading" className="border-t px-6 py-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="docs-heading" className="text-sm font-medium">
          Docs
          {docs.length > 0 && <span className="ml-2 text-muted-foreground">{docs.length}</span>}
        </h2>
        <NewDocButton scope={scope} label="New doc here" />
      </div>
      {docs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No docs attached to {subject} yet.</p>
      ) : (
        <ul className="flex flex-col">
          {docs.map((d) => (
            <li key={d.id}>
              <Link
                href={`/${slug}/docs/${d.id}`}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
              >
                <span className="flex w-5 justify-center">
                  {d.icon ?? <FileText className="size-4 text-muted-foreground" />}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{d.title || "Untitled"}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  Updated {formatShortDate(d.updatedAt, timeZone)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
