import { FileText } from "lucide-react";
import Link from "next/link";

interface BacklinksData {
  documents: { id: string; title: string; icon: string | null }[];
  tasks: { id: string; title: string; teamId: string }[];
}

/**
 * Where this page or task is mentioned: "Linked from" on a document, "Mentioned in" on a task.
 * Server-rendered from `GET …/backlinks`, so it is fresh on every visit. Renders nothing when empty.
 */
export function Backlinks({
  slug,
  heading,
  backlinks,
  teamKeys,
}: {
  slug: string;
  heading: string;
  backlinks: BacklinksData;
  /** Team key by team id, to prefix tasks. */
  teamKeys: ReadonlyMap<string, string>;
}) {
  const { documents, tasks } = backlinks;
  if (documents.length === 0 && tasks.length === 0) return null;
  return (
    <section aria-label={heading} className="mt-10 flex flex-col gap-1 border-t pt-4">
      <h2 className="mb-1 text-sm font-medium text-muted-foreground">
        {heading}
        <span className="ml-2 tabular-nums">{documents.length + tasks.length}</span>
      </h2>
      <ul className="flex flex-col gap-0.5">
        {documents.map((d) => (
          <li key={`doc:${d.id}`}>
            <Link
              href={`/${slug}/docs/${d.id}`}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted"
            >
              <span className="flex w-5 justify-center">
                {d.icon ?? <FileText className="size-4 text-muted-foreground" />}
              </span>
              <span className="truncate">{d.title || "Untitled"}</span>
            </Link>
          </li>
        ))}
        {tasks.map((t) => (
          <li key={`task:${t.id}`}>
            <Link
              href={`/${slug}/task/${t.id}`}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted"
            >
              <span className="w-5 text-center text-xs text-muted-foreground">#</span>
              {teamKeys.get(t.teamId) && (
                <span className="text-xs text-muted-foreground">{teamKeys.get(t.teamId)}</span>
              )}
              <span className="truncate">{t.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
