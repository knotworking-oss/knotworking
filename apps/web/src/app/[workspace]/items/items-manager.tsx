"use client";

import { RecordAttachments } from "@/components/record-attachments";
import {
  allergenCodes,
  allergens,
  ITEM_CSV_TEMPLATE,
  genericItemTypes,
  itemTypeLabels,
  itemTypes,
  storageConditions,
  storageLabels,
  takesFoodDetails,
  unitCodes,
  units,
  type AllergenCode,
  type ItemType,
  type StorageCondition,
  type UnitCode,
} from "@knotworking/core";
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
import { FileUp, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CsvImportDialog } from "@/components/csv-import-dialog";
import { AllergenBadges } from "@/components/item-badges";
import type { Item, Supplier } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceCurrency } from "@/lib/workspace-time";

interface Filters {
  q?: string | undefined;
  type?: ItemType | undefined;
  allergen?: AllergenCode | undefined;
  status: "active" | "all";
}

const ANY = "any";

/** Items → the item list with filters, and the create/edit dialog. */
export function ItemsManager({
  slug,
  items,
  total,
  suppliers,
  filters,
}: {
  slug: string;
  items: Item[];
  total: number;
  suppliers: Supplier[];
  filters: Filters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const canWrite = can("items", "write");
  const showFood = can("food_items");
  const canReadAuthenticity = can("quality");
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState(filters.q ?? "");

  function applyFilters(next: Partial<Filters>) {
    const merged = { ...filters, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.type) params.set("type", merged.type);
    if (merged.allergen) params.set("allergen", merged.allergen);
    if (merged.status === "all") params.set("status", "all");
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  }

  return (
    <div className="workspace-content flex flex-col gap-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Items</h2>
          <p className="text-sm text-muted-foreground">{total} shown</p>
        </div>
        {canWrite && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setImporting(true)}>
              <FileUp data-icon="inline-start" /> Import CSV
            </Button>
            <Button onClick={() => setEditing("new")}>
              <Plus data-icon="inline-start" /> New item
            </Button>
          </div>
        )}
      </div>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters({ q: query.trim() || undefined });
        }}
      >
        <Input
          className="w-64"
          placeholder="Search name or code"
          aria-label="Search items"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          value={filters.type ?? ANY}
          onValueChange={(v) => applyFilters({ type: v === ANY ? undefined : (v as ItemType) })}
        >
          <SelectTrigger className="w-44" aria-label="Type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ANY}>All types</SelectItem>
              {(showFood || filters.type === "ingredient" ? itemTypes : genericItemTypes).map((t) => (
                <SelectItem key={t} value={t}>
                  {itemTypeLabels[t]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {showFood && (
          <Select
            value={filters.allergen ?? ANY}
            onValueChange={(v) => applyFilters({ allergen: v === ANY ? undefined : (v as AllergenCode) })}
          >
            <SelectTrigger className="w-56" aria-label="Allergen">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ANY}>Any allergen</SelectItem>
                {allergenCodes.map((a) => (
                  <SelectItem key={a} value={a}>
                    {allergens[a]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        <div className="flex items-center gap-2 pl-1">
          <Checkbox
            id="items-archived"
            checked={filters.status === "all"}
            onCheckedChange={(on) => applyFilters({ status: on === true ? "all" : "active" })}
          />
          <Label htmlFor="items-archived">Show archived</Label>
        </div>
      </form>

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {filters.q || filters.type || filters.allergen
            ? "No items match these filters."
            : "No items yet. Add materials, products or services to get started."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Unit</TableHead>
                {showFood && <TableHead>Allergens</TableHead>}
                {showFood && <TableHead>Storage</TableHead>}
                <TableHead className="pr-4">Suppliers</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow
                  key={item.id}
                  className={canWrite ? "cursor-pointer" : undefined}
                  onClick={canWrite ? () => setEditing(item) : undefined}
                >
                  <TableCell className="pl-4 font-mono text-xs">{item.code}</TableCell>
                  <TableCell className="font-medium">
                    {canWrite ? (
                      <button
                        type="button"
                        className="text-left hover:underline"
                        onClick={() => setEditing(item)}
                      >
                        {item.name}
                      </button>
                    ) : (
                      item.name
                    )}
                    {item.status === "archived" && (
                      <Badge variant="secondary" className="ml-2">
                        Archived
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{itemTypeLabels[item.type]}</TableCell>
                  <TableCell>{units[item.unit].label}</TableCell>
                  {showFood && (
                    <TableCell className="max-w-xs whitespace-normal">
                      <AllergenBadges
                        contains={item.allergens ?? []}
                        mayContain={item.mayContain ?? []}
                        empty="—"
                      />
                    </TableCell>
                  )}
                  {showFood && <TableCell>{item.storage ? storageLabels[item.storage] : "—"}</TableCell>}
                  <TableCell className="pr-4 text-muted-foreground">
                    {canReadAuthenticity && (
                      <Link
                        className="mb-1 block text-xs underline"
                        href={`/${slug}/quality/authenticity?itemId=${item.id}`}
                      >
                        Authenticity assessments
                      </Link>
                    )}
                    {item.suppliers.map((s) => s.name).join(", ") || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {editing && (
        <ItemDialog
          key={editing === "new" ? "new" : editing.id}
          slug={slug}
          item={editing === "new" ? null : editing}
          suppliers={suppliers}
          onClose={() => setEditing(null)}
        />
      )}
      {importing && <ItemsImportDialog slug={slug} onClose={() => setImporting(false)} />}
    </div>
  );
}

const itemImportLabels = {
  code: "Stock code",
  name: "Name",
  type: "Type",
  unit: "Unit",
  description: "Description",
  density: "Density",
  densityGPerMl: "Density",
  unitWeight: "Unit weight",
  unitWeightG: "Unit weight",
  allergens: "Contains",
  mayContain: "May contain",
  storage: "Storage",
  shelfLife: "Shelf life",
  shelfLifeDays: "Shelf life",
  standardCost: "Standard cost",
  status: "Status",
};

/** Create and update items from a CSV file, matched by stock code. */
function ItemsImportDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const foodWrite = useWorkspace().can("food_items", "write");
  const genericExample = "code,name,type,unit\nBAR-01,Aluminium bar,raw_material,m";
  return (
    <CsvImportDialog
      id="items-csv"
      title="Import items from CSV"
      description="One row per item. A stock code that already exists (in any case) updates that item; a new one creates it."
      columns={
        <>
          Every row needs a <code>code</code>. New items also need a <code>name</code>, a <code>type</code>{" "}
          and a <code>unit</code>. Optional columns include <code>description</code>, <code>density</code>,{" "}
          <code>unit weight</code>, <code>standard cost</code> and <code>status</code>.
          {foodWrite && (
            <>
              {" "}
              Food columns include <code>allergens</code>, <code>may contain</code>, <code>storage</code> and{" "}
              <code>shelf life</code>.
            </>
          )}{" "}
          Omitted columns keep their existing values.
        </>
      }
      template={foodWrite ? ITEM_CSV_TEMPLATE : genericExample}
      templateFileName="items-template.csv"
      placeholder={
        foodWrite
          ? "code,name,type,unit,allergens\nFLOUR-01,Plain flour,ingredient,kg,gluten"
          : genericExample
      }
      noun="item"
      keyLabel="Stock code"
      columnLabels={itemImportLabels}
      run={(csv, fileName, dryRun) =>
        unwrap(
          browserApi().v1.workspaces[":slug"].items.import.$post({
            param: { slug },
            json: { csv, dryRun, ...(fileName ? { fileName } : {}) },
          }),
        )
      }
      onClose={onClose}
    />
  );
}

const numberOrNull = (value: string) => (value.trim() === "" ? null : Number(value));

function AllergenPicker({
  legend,
  idPrefix,
  value,
  onChange,
}: {
  legend: string;
  idPrefix: string;
  value: AllergenCode[];
  onChange: (next: AllergenCode[]) => void;
}) {
  return (
    <Field>
      <FieldLabel id={`${idPrefix}-label`}>{legend}</FieldLabel>
      <div role="group" aria-labelledby={`${idPrefix}-label`} className="grid grid-cols-2 gap-x-4 gap-y-2">
        {allergenCodes.map((code) => (
          <div key={code} className="flex items-center gap-2">
            <Checkbox
              id={`${idPrefix}-${code}`}
              checked={value.includes(code)}
              onCheckedChange={(on) =>
                onChange(on === true ? [...value, code] : value.filter((c) => c !== code))
              }
            />
            <Label htmlFor={`${idPrefix}-${code}`} className="font-normal">
              {allergens[code]}
            </Label>
          </div>
        ))}
      </div>
    </Field>
  );
}

function ItemDialog({
  slug,
  item,
  suppliers,
  onClose,
}: {
  slug: string;
  item: Item | null;
  suppliers: Supplier[];
  onClose: () => void;
}) {
  const router = useRouter();
  const { can } = useWorkspace();
  const showFood = can("food_items");
  const foodWriteAllowed = can("food_items", "write");
  const typeChoices = showFood || item?.type === "ingredient" ? itemTypes : genericItemTypes;
  const [pending, setPending] = useState(false);
  const [code, setCode] = useState(item?.code ?? "");
  const [name, setName] = useState(item?.name ?? "");
  const [type, setType] = useState<ItemType>(item?.type ?? (showFood ? "ingredient" : "raw_material"));
  // Allergens, storage and shelf life only for types that can hold food (not services or spare parts).
  const foodWrite = foodWriteAllowed && takesFoodDetails(type);
  const [unit, setUnit] = useState<UnitCode>(item?.unit ?? (showFood ? "kg" : "each"));
  const [storage, setStorage] = useState<StorageCondition>(item?.storage ?? "ambient");
  const [description, setDescription] = useState(item?.description ?? "");
  const [contains, setContains] = useState<AllergenCode[]>(item?.allergens ?? []);
  const [mayContain, setMayContain] = useState<AllergenCode[]>(item?.mayContain ?? []);
  const [shelfLife, setShelfLife] = useState(item?.shelfLifeDays?.toString() ?? "");
  const [cost, setCost] = useState(item?.standardCost?.toString() ?? "");
  const currency = useWorkspaceCurrency();
  const [density, setDensity] = useState(item?.densityGPerMl?.toString() ?? "");
  const [unitWeight, setUnitWeight] = useState(item?.unitWeightG?.toString() ?? "");
  const [supplierIds, setSupplierIds] = useState<string[]>(item?.suppliers.map((s) => s.supplierId) ?? []);
  // Once an item exists its unit can only change within the same kind (weight, volume, count).
  const dimension = item ? units[item.unit].dimension : null;
  const unitChoices = unitCodes.filter((u) => !dimension || units[u].dimension === dimension);

  async function save(extra: { status?: "active" | "archived" } = {}) {
    setPending(true);
    const body = {
      code: code.trim(),
      name: name.trim(),
      type,
      unit,
      description: description.trim() || null,
      ...(foodWrite
        ? { storage, allergens: contains, mayContain, shelfLifeDays: numberOrNull(shelfLife) }
        : {}),
      standardCost: numberOrNull(cost),
      densityGPerMl: numberOrNull(density),
      unitWeightG: numberOrNull(unitWeight),
      suppliers: supplierIds.map((supplierId) => ({ supplierId })),
    };
    const api = browserApi().v1.workspaces[":slug"].items;
    try {
      if (item) {
        await unwrap(api[":id"].$patch({ param: { slug, id: item.id }, json: { ...body, ...extra } }));
      } else {
        await unwrap(api.$post({ param: { slug }, json: body }));
      }
      toast.success(item ? `${body.name} saved` : `${body.name} added`);
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{item ? "Edit item" : "New item"}</DialogTitle>
            <DialogDescription>
              {foodWriteAllowed
                ? "Allergen declarations are used in recipes and on labels."
                : "Set the catalogue details for this item."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
              <Field>
                <FieldLabel htmlFor="item-code">Code</FieldLabel>
                <Input
                  id="item-code"
                  required
                  maxLength={40}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="item-name">Name</FieldLabel>
                <Input
                  id="item-name"
                  required
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel id="item-type-label">Type</FieldLabel>
                <Select value={type} onValueChange={(v) => setType(v as ItemType)}>
                  <SelectTrigger aria-labelledby="item-type-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {typeChoices.map((t) => (
                        <SelectItem key={t} value={t}>
                          {itemTypeLabels[t]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel id="item-unit-label">Unit</FieldLabel>
                <Select value={unit} onValueChange={(v) => setUnit(v as UnitCode)}>
                  <SelectTrigger aria-labelledby="item-unit-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {unitChoices.map((u) => (
                        <SelectItem key={u} value={u}>
                          {units[u].label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {foodWrite && (
                <Field>
                  <FieldLabel id="item-storage-label">Storage</FieldLabel>
                  <Select value={storage} onValueChange={(v) => setStorage(v as StorageCondition)}>
                    <SelectTrigger aria-labelledby="item-storage-label" className="w-full">
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
              )}
            </div>
            {item && (
              <FieldDescription>
                The unit can change between {unitChoices.map((u) => units[u].label).join(", ")} only: stored
                quantities depend on it.
              </FieldDescription>
            )}

            {foodWrite && (
              <>
                <AllergenPicker
                  legend="Contains"
                  idPrefix="item-contains"
                  value={contains}
                  onChange={setContains}
                />
                <AllergenPicker
                  legend="May contain (cross-contact)"
                  idPrefix="item-may"
                  value={mayContain}
                  onChange={setMayContain}
                />
              </>
            )}
            <div className="grid gap-4 sm:grid-cols-4">
              {foodWrite && (
                <Field>
                  <FieldLabel htmlFor="item-shelf">Shelf life (days)</FieldLabel>
                  <Input
                    id="item-shelf"
                    type="number"
                    min={0}
                    max={3650}
                    step={1}
                    value={shelfLife}
                    onChange={(e) => setShelfLife(e.target.value)}
                  />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="item-cost">
                  Cost per {units[unit].label} ({currency})
                </FieldLabel>
                <Input
                  id="item-cost"
                  type="number"
                  min={0}
                  step="any"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="item-density">Density (g/ml)</FieldLabel>
                <Input
                  id="item-density"
                  type="number"
                  min={0}
                  step="any"
                  value={density}
                  onChange={(e) => setDensity(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="item-weight">Weight each (g)</FieldLabel>
                <Input
                  id="item-weight"
                  type="number"
                  min={0}
                  step="any"
                  value={unitWeight}
                  onChange={(e) => setUnitWeight(e.target.value)}
                />
              </Field>
            </div>
            <FieldDescription>
              Density and weight each are optional. They let quantities convert between volume, count and
              weight.
            </FieldDescription>

            {suppliers.length > 0 && (
              <Field>
                <FieldLabel id="item-suppliers-label">Suppliers</FieldLabel>
                <div
                  role="group"
                  aria-labelledby="item-suppliers-label"
                  className="grid grid-cols-2 gap-x-4 gap-y-2"
                >
                  {suppliers.map((s) => (
                    <div key={s.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`item-supplier-${s.id}`}
                        checked={supplierIds.includes(s.id)}
                        onCheckedChange={(on) =>
                          setSupplierIds(
                            on === true ? [...supplierIds, s.id] : supplierIds.filter((id) => id !== s.id),
                          )
                        }
                      />
                      <Label htmlFor={`item-supplier-${s.id}`} className="font-normal">
                        {s.name}
                        {s.approvalStatus !== "approved" && (
                          <span className="text-muted-foreground"> ({s.approvalStatus})</span>
                        )}
                      </Label>
                    </div>
                  ))}
                </div>
              </Field>
            )}

            <Field>
              <FieldLabel htmlFor="item-description">Notes</FieldLabel>
              <Textarea
                id="item-description"
                rows={2}
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          </FieldGroup>
          {item && <RecordAttachments entityType="item" entityId={item.id} />}
          <DialogFooter>
            {item && (
              <Button
                type="button"
                variant="ghost"
                className="sm:mr-auto"
                disabled={pending}
                onClick={() => void save({ status: item.status === "archived" ? "active" : "archived" })}
              >
                {item.status === "archived" ? "Restore" : "Archive"}
              </Button>
            )}
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {item ? "Save" : "Add item"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
