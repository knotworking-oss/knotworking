"use client";

import { Button } from "@knotworking/ui/components/button";
import { Checkbox } from "@knotworking/ui/components/checkbox";
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
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { RadioGroup, RadioGroupItem } from "@knotworking/ui/components/radio-group";
import { Spinner } from "@knotworking/ui/components/spinner";
import {
  Archive,
  ArchiveRestore,
  Braces,
  CopyPlus,
  EllipsisVertical,
  LayoutTemplate,
  Pencil,
  Send,
  Snowflake,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { SpecJson } from "@/components/dashboard-editor";
import type { DashboardDetail } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { omittedNotice } from "@/lib/bi-format";
import { useWorkspace } from "@/lib/workspace-store";

/**
 * What a viewer can do with a dashboard: edit it (owner of a draft, or `manage`), duplicate it into
 * their own draft (`write`), see its JSON, save it as a template, publish or take it back to draft
 * (`manage`), and archive it. The API checks each again.
 */
export function DashboardActions({
  slug,
  dashboard,
  view,
}: {
  slug: string;
  dashboard: DashboardDetail;
  /** The period and filters on screen: what a snapshot freezes. */
  view: { period?: object; filters: Record<string, string | string[]> };
}) {
  const router = useRouter();
  const { can, viewer } = useWorkspace();
  const [json, setJson] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [busy, setBusy] = useState(false);
  const api = browserApi().v1.workspaces[":slug"].bi.dashboards[":id"];
  const param = { slug, id: dashboard.id };
  const manager = can("bi", "manage");
  const canWrite = can("bi", "write");
  const canArchive = manager || (dashboard.ownerId === viewer.id && dashboard.status === "draft");

  async function run<T>(fn: () => Promise<T>, done: string, then?: (value: T) => void) {
    setBusy(true);
    try {
      const value = await fn();
      toast.success(done);
      if (then) then(value);
      else router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5 print:hidden">
      {dashboard.canEdit && (
        <Button size="sm" asChild>
          <Link href={`/${slug}/dashboards/${dashboard.id}/edit`}>
            <Pencil /> Edit
          </Link>
        </Button>
      )}
      {manager && dashboard.status === "draft" && !dashboard.archivedAt && (
        <Button size="sm" variant="outline" onClick={() => setPublishing(true)} disabled={busy}>
          <Send /> Publish
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="More actions" disabled={busy}>
            {busy ? <Spinner /> : <EllipsisVertical />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canWrite && (
            <DropdownMenuItem
              onSelect={() =>
                void run(
                  () => unwrap(api.duplicate.$post({ param, json: {} })),
                  "Copied into a new draft",
                  (copy) => {
                    if (copy.omittedWidgets > 0) toast.info(omittedNotice(copy.omittedWidgets));
                    router.push(`/${slug}/dashboards/${copy.id}/edit`);
                  },
                )
              }
            >
              <CopyPlus /> Duplicate as my draft
            </DropdownMenuItem>
          )}
          {manager && (
            <DropdownMenuItem
              onSelect={() =>
                void run(
                  () => unwrap(api.snapshots.$post({ param, json: { params: view as never } })),
                  "Snapshot taken: these figures are now frozen",
                  (snapshot) => router.push(`/${slug}/dashboards/snapshots/${snapshot.id}`),
                )
              }
            >
              <Snowflake /> Take a board snapshot
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setJson(true)}>
            <Braces /> View JSON
          </DropdownMenuItem>
          {dashboard.canEdit && (
            <DropdownMenuItem
              onSelect={() =>
                void run(
                  () =>
                    unwrap(
                      api.$patch({
                        param,
                        json: { template: !dashboard.template, expectedVersion: dashboard.version },
                      }),
                    ),
                  dashboard.template ? "No longer a template" : "Saved as a template",
                )
              }
            >
              <LayoutTemplate /> {dashboard.template ? "Stop offering as a template" : "Save as template"}
            </DropdownMenuItem>
          )}
          {manager && dashboard.status === "published" && (
            <DropdownMenuItem
              onSelect={() => void run(() => unwrap(api.unpublish.$post({ param })), "Back to draft")}
            >
              <Undo2 /> Take back to draft
            </DropdownMenuItem>
          )}
          {canArchive && (
            <>
              <DropdownMenuSeparator />
              {dashboard.archivedAt ? (
                <DropdownMenuItem
                  onSelect={() => void run(() => unwrap(api.restore.$post({ param })), "Restored")}
                >
                  <ArchiveRestore /> Restore
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onSelect={() =>
                    void run(
                      () => unwrap(api.archive.$post({ param })),
                      "Archived",
                      () => router.push(`/${slug}/dashboards`),
                    )
                  }
                >
                  <Archive /> Archive
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={json} onOpenChange={setJson}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Dashboard JSON</DialogTitle>
            <DialogDescription>
              The spec as stored, version {dashboard.version}. Read-only: change it in the builder or through
              your AI agent.
            </DialogDescription>
          </DialogHeader>
          <SpecJson
            value={{
              title: dashboard.title,
              description: dashboard.description ?? undefined,
              scope: dashboard.scope,
              spec: dashboard.spec,
            }}
          />
        </DialogContent>
      </Dialog>
      {publishing && <PublishDialog slug={slug} dashboard={dashboard} onClose={() => setPublishing(false)} />}
    </div>
  );
}

/** Publish to the whole workspace or named members, for the version on screen. */
function PublishDialog({
  slug,
  dashboard,
  onClose,
}: {
  slug: string;
  dashboard: DashboardDetail;
  onClose: () => void;
}) {
  const router = useRouter();
  const { idx } = useWorkspace();
  // Opens on the audience it last had, so republishing to named people keeps them.
  const [audience, setAudience] = useState<"workspace" | "members">(dashboard.audience);
  const [members, setMembers] = useState<Set<string>>(new Set(dashboard.audienceUserIds));
  const [pending, setPending] = useState(false);
  const people = [...idx.users.values()].sort((a, b) => a.name.localeCompare(b.name));

  async function publish() {
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].bi.dashboards[":id"].publish.$post({
          param: { slug, id: dashboard.id },
          json: {
            audience,
            memberIds: audience === "members" ? [...members] : [],
            expectedVersion: dashboard.version,
          },
        }),
      );
      toast.success("Published");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish “{dashboard.title}”</DialogTitle>
          <DialogDescription>
            Version {dashboard.version}, as you see it now. Each person still sees only the data they can
            read.
          </DialogDescription>
        </DialogHeader>
        <RadioGroup value={audience} onValueChange={(v) => setAudience(v as "workspace" | "members")}>
          <Field orientation="horizontal">
            <RadioGroupItem value="workspace" id="aud-ws" />
            <FieldLabel htmlFor="aud-ws">Everyone who can open dashboards</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem value="members" id="aud-members" />
            <FieldLabel htmlFor="aud-members">Named people</FieldLabel>
          </Field>
        </RadioGroup>
        {audience === "members" && (
          <div className="flex max-h-56 flex-col gap-2 overflow-y-auto rounded-md border p-2">
            {people.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={members.has(p.id)}
                  onCheckedChange={(on) => {
                    const next = new Set(members);
                    if (on) next.add(p.id);
                    else next.delete(p.id);
                    setMembers(next);
                  }}
                />
                {p.name}
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            onClick={() => void publish()}
            disabled={pending || (audience === "members" && members.size === 0)}
          >
            {pending && <Spinner data-icon="inline-start" />} Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
