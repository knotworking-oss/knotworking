"use client";

import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Label } from "@knotworking/ui/components/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
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
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { Item, ReleaseRuleRow } from "@/lib/api";
import { browserApi, errorMessage, unwrap, unwrapEmpty } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

/** Stock → release rules: per item, what must be true before one of its lots can be released. */
export function ReleaseRules({
  slug,
  rules,
  items,
}: {
  slug: string;
  rules: ReleaseRuleRow[];
  items: Item[];
}) {
  const canManage = useWorkspace().can("stock", "manage");
  const [editing, setEditing] = useState<{ rule: ReleaseRuleRow | null } | null>(null);
  const requirements = (r: ReleaseRuleRow) =>
    [
      r.requirePassingTest &&
        `Passing test${r.requiredAnalytes.length ? ` (${r.requiredAnalytes.join(", ")})` : ""}`,
      r.requireApprovedSpecification && "Approved specification",
      r.requireCcpReviewed && "CCP monitoring reviewed",
    ].filter(Boolean) as string[];
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href={`/${slug}/stock`} className="hover:underline">
              Stock
            </Link>{" "}
            / Release rules
          </p>
          <h2 className="text-xl font-semibold tracking-tight">Release rules</h2>
        </div>
        {canManage && (
          <Button onClick={() => setEditing({ rule: null })}>
            <Plus data-icon="inline-start" /> New rule
          </Button>
        )}
      </div>
      {rules.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No release rules yet.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Item</TableHead>
                <TableHead>Requires</TableHead>
                <TableHead>Version</TableHead>
                <TableHead className="pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-4">
                    <span className="font-mono text-xs">{r.item.code}</span> {r.item.name}
                    {r.note && (
                      <div className="max-w-xs text-xs whitespace-normal text-muted-foreground">{r.note}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {requirements(r).map((x) => (
                        <Badge key={x} variant="outline">
                          {x}
                        </Badge>
                      ))}
                      {requirements(r).length === 0 && (
                        <span className="text-muted-foreground">Nothing extra</span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    v{r.version}
                    {r.updatedByName ? (
                      <span className="text-xs text-muted-foreground"> · {r.updatedByName}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    {canManage && (
                      <Button variant="ghost" size="sm" onClick={() => setEditing({ rule: r })}>
                        Edit
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {editing && (
        <RuleDialog
          slug={slug}
          rule={editing.rule}
          items={items.filter((i) => editing.rule || !rules.some((r) => r.itemId === i.id))}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function RuleDialog({
  slug,
  rule,
  items,
  onClose,
}: {
  slug: string;
  rule: ReleaseRuleRow | null;
  items: Item[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const [itemId, setItemId] = useState(rule?.itemId ?? "");
  const [requirePassingTest, setRequirePassingTest] = useState(rule?.requirePassingTest ?? true);
  const [analytes, setAnalytes] = useState((rule?.requiredAnalytes ?? []).join(", "));
  const [requireSpec, setRequireSpec] = useState(rule?.requireApprovedSpecification ?? false);
  const [requireCcp, setRequireCcp] = useState(rule?.requireCcpReviewed ?? false);
  const [note, setNote] = useState(rule?.note ?? "");
  const api = () => browserApi().v1.workspaces[":slug"].stock["release-rules"][":itemId"];

  async function run(kind: "save" | "delete", action: () => Promise<unknown>, done: string) {
    setPending(kind);
    try {
      await action();
      toast.success(done);
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }
  function save(e: FormEvent) {
    e.preventDefault();
    void run(
      "save",
      () =>
        unwrap(
          api().$put({
            param: { slug, itemId },
            json: {
              requirePassingTest,
              requiredAnalytes: requirePassingTest
                ? analytes
                    .split(",")
                    .map((a) => a.trim())
                    .filter(Boolean)
                : [],
              requireApprovedSpecification: requireSpec,
              requireCcpReviewed: requireCcp,
              note: note.trim() || null,
            },
          }),
        ),
      "Release rule saved",
    );
  }
  const toggle = (id: string, label: string, checked: boolean, set: (v: boolean) => void, hint: string) => (
    <div className="flex gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => set(v === true)} />
      <div className="flex flex-col">
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
    </div>
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={save}>
          <DialogHeader>
            <DialogTitle>{rule ? `Release rule for ${rule.item.code}` : "New release rule"}</DialogTitle>
            <DialogDescription>
              {rule
                ? `Saving makes version ${rule.version + 1}.`
                : "What a lot of this item needs before release."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            {!rule && (
              <Field>
                <FieldLabel htmlFor="rule-item">Item</FieldLabel>
                <Select value={itemId} onValueChange={setItemId}>
                  <SelectTrigger id="rule-item" className="w-full">
                    <SelectValue placeholder="Choose an item" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {[...items]
                        .sort((a, b) => a.code.localeCompare(b.code))
                        .map((i) => (
                          <SelectItem key={i.id} value={i.id}>
                            {i.code} · {i.name}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
            {toggle(
              "rule-test",
              "A passing test",
              requirePassingTest,
              setRequirePassingTest,
              "A complete, passing sample on the lot (Testing).",
            )}
            {requirePassingTest && (
              <Field>
                <FieldLabel htmlFor="rule-analytes">Covering these analytes</FieldLabel>
                <Input
                  id="rule-analytes"
                  placeholder="Comma-separated, e.g. Salmonella, Listeria monocytogenes"
                  value={analytes}
                  onChange={(e) => setAnalytes(e.target.value)}
                />
                <FieldDescription>Leave empty for any passing sample.</FieldDescription>
              </Field>
            )}
            {toggle(
              "rule-spec",
              "An approved specification",
              requireSpec,
              setRequireSpec,
              "The item has an approved specification (Specifications).",
            )}
            {toggle(
              "rule-ccp",
              "CCP monitoring reviewed",
              requireCcp,
              setRequireCcp,
              "For lots made in production: every CCP reading approved, no corrective action open.",
            )}
            <Field>
              <FieldLabel htmlFor="rule-note">Why</FieldLabel>
              <Textarea
                id="rule-note"
                maxLength={2000}
                placeholder="The product's risk, a customer's requirement"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            {rule && (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto"
                disabled={pending !== null}
                onClick={() =>
                  void run(
                    "delete",
                    () => unwrapEmpty(api().$delete({ param: { slug, itemId } })),
                    "Release rule removed",
                  )
                }
              >
                Remove rule
              </Button>
            )}
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending !== null || !itemId}>
              {pending === "save" && <Spinner data-icon="inline-start" />} Save rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
