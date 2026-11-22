"use client";

import { sopCopyStatusLabels } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Printer } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { SopCopyRow, SopDetail } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useFormatDateTime } from "@/lib/workspace-time";

const sopsApi = () => browserApi().v1.workspaces[":slug"].sops;

/**
 * The controlled-copy register of one SOP (SOPs `manage`): issue a numbered printed copy of the
 * current approved version, and record it returned or destroyed. Copies of a version that is no
 * longer current are flagged: they are to be called in.
 */
export function ControlledCopies({
  slug,
  sop,
  copies,
}: {
  slug: string;
  sop: SopDetail;
  copies: SopCopyRow[];
}) {
  const router = useRouter();
  const time = useFormatDateTime();
  const [issuing, setIssuing] = useState(false);
  const [closing, setClosing] = useState<SopCopyRow | null>(null);
  const out = copies.filter((c) => c.status === "issued");
  const stale = out.filter((c) => c.outOfDate);

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h3 className="font-medium">Controlled copies</h3>
          <Button
            size="sm"
            disabled={!sop.currentVersion || sop.status !== "active"}
            title={sop.currentVersion ? undefined : "Approve a version first"}
            onClick={() => setIssuing(true)}
          >
            <Printer data-icon="inline-start" /> Issue a copy
          </Button>
        </div>
        {stale.length > 0 && (
          <p className="text-status-red">
            {stale.length} {stale.length === 1 ? "copy is" : "copies are"} of an old version and should be
            called in and replaced.
          </p>
        )}
      </Card>

      {copies.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No copies have been issued.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {copies.map((c) => (
            <li key={c.id}>
              <Card className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    Copy {c.copyNumber} of v{c.versionNumber}
                    <Badge variant={c.status === "issued" ? "secondary" : "outline"}>
                      {sopCopyStatusLabels[c.status]}
                    </Badge>
                    {c.outOfDate && (
                      <Badge className="bg-status-red/15 text-status-red border-transparent">
                        Old version
                      </Badge>
                    )}
                  </div>
                  <div className="text-muted-foreground">
                    {c.issuedTo}
                    {c.location ? ` · ${c.location}` : ""} · issued {time(c.issuedAt)}
                    {c.issuedByName ? ` by ${c.issuedByName}` : ""}
                  </div>
                  {c.closedAt && (
                    <div className="text-muted-foreground">
                      {sopCopyStatusLabels[c.status]} {time(c.closedAt)}
                      {c.closedByName ? ` by ${c.closedByName}` : ""}
                      {c.closedNote ? ` · ${c.closedNote}` : ""}
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  {c.status === "issued" && c.current && (
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/${slug}/sops/${sop.id}/print?copy=${c.id}`}>Print</Link>
                    </Button>
                  )}
                  {c.status === "issued" && (
                    <Button variant="outline" size="sm" onClick={() => setClosing(c)}>
                      Return or destroy
                    </Button>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{out.length} still out.</p>

      {issuing && <IssueDialog slug={slug} sop={sop} onClose={() => setIssuing(false)} />}
      {closing && (
        <CloseDialog
          slug={slug}
          copy={closing}
          onClose={() => setClosing(null)}
          onDone={() => {
            setClosing(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

const NO_MEMBER = "none";

function IssueDialog({ slug, sop, onClose }: { slug: string; sop: SopDetail; onClose: () => void }) {
  const router = useRouter();
  const { idx } = useWorkspace();
  const [pending, setPending] = useState(false);
  const [member, setMember] = useState(NO_MEMBER);
  const [place, setPlace] = useState("");
  const [location, setLocation] = useState("");
  const users = [...idx.users.values()].sort((a, b) => a.name.localeCompare(b.name));
  const ready = member !== NO_MEMBER || place.trim() !== "";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const copy = await unwrap(
        sopsApi()[":id"].copies.$post({
          param: { slug, id: sop.id },
          json: {
            ...(member !== NO_MEMBER ? { issuedToUserId: member } : {}),
            ...(place.trim() ? { issuedTo: place.trim() } : {}),
            location: location.trim() || null,
          },
        }),
      );
      toast.success(`Copy ${copy.copyNumber} issued`);
      router.push(`/${slug}/sops/${sop.id}/print?copy=${copy.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Issue a controlled copy</DialogTitle>
            <DialogDescription>
              Records the copy against the current version, then opens it to print with its copy number.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel id="copy-member-label">Issued to (member)</FieldLabel>
              <Select value={member} onValueChange={setMember}>
                <SelectTrigger aria-labelledby="copy-member-label" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={NO_MEMBER}>Not a member</SelectItem>
                    {users.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="copy-place">Or a name or place</FieldLabel>
              <Input
                id="copy-place"
                maxLength={200}
                placeholder="e.g. Packing room"
                value={place}
                onChange={(e) => setPlace(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="copy-location">Where it is kept</FieldLabel>
              <Input
                id="copy-location"
                maxLength={200}
                placeholder="e.g. Wall file by the door"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || !ready}>
              {pending && <Spinner data-icon="inline-start" />}
              Issue and print
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CloseDialog({
  slug,
  copy,
  onClose,
  onDone,
}: {
  slug: string;
  copy: SopCopyRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"returned" | "destroyed">("returned");
  const [note, setNote] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await unwrap(
        sopsApi().copies[":copyId"].close.$post({
          param: { slug, copyId: copy.id },
          json: { status, note: note.trim() || null },
        }),
      );
      toast.success(`Copy ${copy.copyNumber} ${status}`);
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>
              Copy {copy.copyNumber} of v{copy.versionNumber}
            </DialogTitle>
            <DialogDescription>Record that this printed copy is no longer out.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel id="copy-status-label">What happened to it</FieldLabel>
              <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
                <SelectTrigger aria-labelledby="copy-status-label" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="returned">Returned to the document controller</SelectItem>
                    <SelectItem value="destroyed">Destroyed</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="copy-note">Note</FieldLabel>
              <Input
                id="copy-note"
                maxLength={1000}
                placeholder="e.g. Shredded"
                value={note}
                onChange={(e) => setNote(e.target.value)}
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
              {pending && <Spinner data-icon="inline-start" />}
              Record
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
