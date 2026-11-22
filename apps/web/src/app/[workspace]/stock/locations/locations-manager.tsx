"use client";

import { storageConditions, storageLabels, type StorageCondition } from "@knotworking/core";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { StockLocation } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

/** Stock → Locations: where stock is kept. A location can be archived once it is empty. */
export function LocationsManager({ slug, locations }: { slug: string; locations: StockLocation[] }) {
  const canWrite = useWorkspace().can("stock", "write");
  const [editing, setEditing] = useState<StockLocation | "new" | null>(null);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Locations</h2>
        {canWrite && (
          <Button onClick={() => setEditing("new")}>
            <Plus data-icon="inline-start" /> New location
          </Button>
        )}
      </div>

      {locations.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No locations yet. Add one before receiving stock.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead className="pr-4 text-right">Lots in stock</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {locations.map((l) => (
                <TableRow
                  key={l.id}
                  className={canWrite ? "cursor-pointer" : undefined}
                  onClick={canWrite ? () => setEditing(l) : undefined}
                >
                  <TableCell className="pl-4 font-medium">
                    {l.name}
                    {l.status === "archived" && (
                      <Badge variant="secondary" className="ml-2">
                        Archived
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{l.code ?? "—"}</TableCell>
                  <TableCell>{storageLabels[l.storage]}</TableCell>
                  <TableCell className="pr-4 text-right tabular-nums">{l.lotCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {editing && (
        <LocationDialog
          key={editing === "new" ? "new" : editing.id}
          slug={slug}
          location={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function LocationDialog({
  slug,
  location,
  onClose,
}: {
  slug: string;
  location: StockLocation | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [name, setName] = useState(location?.name ?? "");
  const [code, setCode] = useState(location?.code ?? "");
  const [storage, setStorage] = useState<StorageCondition>(location?.storage ?? "ambient");

  async function save(extra: { status?: "active" | "archived" } = {}) {
    setPending(true);
    const body = { name: name.trim(), code: code.trim() || null, storage };
    const api = browserApi().v1.workspaces[":slug"].stock.locations;
    try {
      if (location) {
        await unwrap(api[":id"].$patch({ param: { slug, id: location.id }, json: { ...body, ...extra } }));
      } else {
        await unwrap(api.$post({ param: { slug }, json: body }));
      }
      toast.success(
        extra.status === "archived"
          ? `${body.name} archived`
          : extra.status === "active"
            ? `${body.name} restored`
            : location
              ? `${body.name} saved`
              : `${body.name} added`,
      );
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
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{location ? "Edit location" : "New location"}</DialogTitle>
            <DialogDescription>A location can be archived once it holds no stock.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="location-name">Name</FieldLabel>
              <Input
                id="location-name"
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="location-code">Code</FieldLabel>
                <Input
                  id="location-code"
                  maxLength={40}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel id="location-storage-label">Storage</FieldLabel>
                <Select value={storage} onValueChange={(v) => setStorage(v as StorageCondition)}>
                  <SelectTrigger aria-labelledby="location-storage-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {storageConditions.map((s) => (
                        <SelectItem key={s} value={s}>
                          {storageLabels[s]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </FieldGroup>
          <DialogFooter>
            {location && (
              <Button
                type="button"
                variant="outline"
                className="sm:mr-auto"
                disabled={pending}
                onClick={() => void save({ status: location.status === "archived" ? "active" : "archived" })}
              >
                {location.status === "archived" ? "Restore" : "Archive"}
              </Button>
            )}
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {location ? "Save" : "Add location"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
