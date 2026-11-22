"use client";

import { Badge } from "@knotworking/ui/components/badge";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@knotworking/ui/components/empty";
import { Field, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Spinner } from "@knotworking/ui/components/spinner";
import { BadgeCheck, BookCopy, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { PackSummary, SnapshotSummary } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspaceToday } from "@/lib/workspace-time";

export function PackList({
  slug,
  packs,
  analyses,
  canManage,
}: {
  slug: string;
  packs: PackSummary[];
  /** Verified agent analyses: the viewer's own, or every one for managers. */
  analyses: SnapshotSummary[];
  canManage: boolean;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <div className="flex items-center justify-end gap-2">
        {canManage && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New pack
          </Button>
        )}
      </div>
      {packs.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BookCopy />
            </EmptyMedia>
            <EmptyTitle>No board packs yet</EmptyTitle>
            <EmptyDescription>
              {canManage
                ? "Take a board snapshot from a dashboard's menu, then gather snapshots into a pack."
                : "Packs appear here once someone issues one to you."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y rounded-lg border">
          {packs.map((p) => (
            <li key={p.id}>
              <Link
                href={`/${slug}/dashboards/packs/${p.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
              >
                <BookCopy className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.title}</div>
                  <div className="text-sm text-muted-foreground">
                    As at {p.asAt} · {p.items.length} {p.items.length === 1 ? "snapshot" : "snapshots"}
                  </div>
                </div>
                <Badge variant={p.status === "issued" ? "secondary" : "outline"}>
                  {p.status === "issued" ? "Issued" : "Draft"}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <section className="flex flex-col gap-2" aria-labelledby="analyses">
        <h2 id="analyses" className="text-sm font-medium">
          Analyses
        </h2>
        <p className="text-sm text-muted-foreground">
          Scenario comparisons built by AI agents through MCP (create_analysis), with every figure checked
          against its sources.{" "}
          {canManage
            ? "Add one to a pack like any snapshot."
            : "Someone who manages dashboards can add one to a pack."}
        </p>
        {analyses.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No analyses yet. Ask your agent a what-if question, such as what would change if an order were
            dropped.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {analyses.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/${slug}/dashboards/snapshots/${a.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
                >
                  <BadgeCheck className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-medium">{a.title}</span>
                  <span className="text-sm text-muted-foreground">{a.asAt}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      {creating && <NewPackDialog slug={slug} onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewPackDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const router = useRouter();
  const today = useWorkspaceToday();
  const [title, setTitle] = useState("");
  const [asAt, setAsAt] = useState(today);
  const [pending, setPending] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const pack = await unwrap(
        browserApi().v1.workspaces[":slug"].bi.packs.$post({ param: { slug }, json: { title, asAt } }),
      );
      router.push(`/${slug}/dashboards/packs/${pack.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New board pack</DialogTitle>
            <DialogDescription>
              A draft only people who manage dashboards see, until you issue it.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="pack-title">Title</FieldLabel>
              <Input
                id="pack-title"
                required
                maxLength={160}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Board meeting, November"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="pack-as-at">For the meeting on</FieldLabel>
              <Input
                id="pack-as-at"
                type="date"
                required
                value={asAt}
                onChange={(e) => setAsAt(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || !title.trim()}>
              {pending && <Spinner data-icon="inline-start" />} Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
