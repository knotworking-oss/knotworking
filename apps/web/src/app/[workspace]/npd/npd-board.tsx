"use client";

import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Spinner } from "@knotworking/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Textarea } from "@knotworking/ui/components/textarea";
import { Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { NpdStatusBadge } from "@/components/npd-badges";
import type { NpdProjectRow } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

/** Product development → the project list and the new-project dialog. */
export function NpdBoard({
  slug,
  projects,
  status,
}: {
  slug: string;
  projects: NpdProjectRow[];
  status: "open" | "all";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const timeZone = useWorkspaceTimeZone();
  const canWrite = useWorkspace().can("npd", "write");
  const [creating, setCreating] = useState(false);
  return (
    <div className="workspace-content flex flex-col gap-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex gap-2">
          <Button
            variant={status === "all" ? "secondary" : "outline"}
            aria-pressed={status === "all"}
            onClick={() => router.replace(status === "all" ? pathname : `${pathname}?status=all`)}
          >
            Include launched and cancelled
          </Button>
          {canWrite && (
            <Button onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" /> New project
            </Button>
          )}
        </div>
      </div>
      {projects.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No projects {status === "open" ? "in progress" : "yet"}.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Code</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Target launch</TableHead>
                <TableHead>Recipe</TableHead>
                <TableHead>Trials</TableHead>
                <TableHead className="pr-4">Stage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="pl-4 font-mono text-xs">{p.code}</TableCell>
                  <TableCell className="font-medium">
                    <Link href={`/${slug}/npd/${p.id}`} className="hover:underline">
                      {p.name}
                    </Link>
                  </TableCell>
                  <TableCell>{p.customerName ?? "—"}</TableCell>
                  <TableCell>{p.targetLaunchOn ? formatLongDate(p.targetLaunchOn, timeZone) : "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{p.recipeCode ?? "—"}</TableCell>
                  <TableCell>{p.trialCount}</TableCell>
                  <TableCell className="pr-4">
                    <NpdStatusBadge status={p.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {creating && <NewProjectDialog slug={slug} onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewProjectDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [customer, setCustomer] = useState("");
  async function create(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const created = await unwrap(
        browserApi().v1.workspaces[":slug"].npd.projects.$post({
          param: { slug },
          json: {
            code: code.trim(),
            name: name.trim(),
            brief: brief.trim() || null,
            customerName: customer.trim() || null,
          },
        }),
      );
      toast.success(`${created.code} started`);
      router.push(`/${slug}/npd/${created.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(e) => void create(e)}>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Start with the concept; fill in targets and links as the project takes shape.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
              <Field>
                <FieldLabel htmlFor="npd-code">Code</FieldLabel>
                <Input
                  id="npd-code"
                  required
                  maxLength={40}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="npd-name">Name</FieldLabel>
                <Input
                  id="npd-name"
                  required
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="npd-customer">Customer</FieldLabel>
              <Input
                id="npd-customer"
                maxLength={200}
                placeholder="Leave empty for our own brand"
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="npd-brief">Concept</FieldLabel>
              <Textarea
                id="npd-brief"
                maxLength={10_000}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />} Start project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
