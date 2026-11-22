"use client";

import { baseUnits, unitDimension, unitsForItem, units, type UnitCode } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
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
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { DemandPackUnit, Item } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

const formatNumber = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 4 });

/**
 * Units of sale: named packs of a product with their size (case = 12 each, tray = 2.5 kg). Demand
 * can be entered in them; it is stored in the product's base unit.
 */
export function PackUnitsDialog({
  slug,
  products,
  packUnits,
  onClose,
}: {
  slug: string;
  products: Item[];
  packUnits: DemandPackUnit[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [itemId, setItemId] = useState("");
  const [name, setName] = useState("");
  const [size, setSize] = useState("");
  const [unit, setUnit] = useState<UnitCode | "">("");
  const [busy, setBusy] = useState(false);
  const item = products.find((p) => p.id === itemId);
  const base = item ? baseUnits[unitDimension(item.unit)] : undefined;
  const mine = packUnits.filter((p) => p.itemId === itemId);

  async function send(packs: { name: string; size: number | null; unit?: UnitCode }[], done: string) {
    if (!item) return;
    setBusy(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].demand["pack-units"].$put({
          param: { slug },
          json: { packUnits: packs.map((p) => ({ itemId: item.id, ...p })) },
        }),
      );
      toast.success(done);
      router.refresh();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const n = Number(size.replace(",", "."));
    if (!name.trim() || !Number.isFinite(n) || n <= 0) {
      toast.error("Give the pack a name and a size above 0");
      return;
    }
    const saved = await send(
      [{ name: name.trim(), size: n, ...(unit ? { unit } : {}) }],
      `${name.trim()} saved`,
    );
    if (saved) {
      setName("");
      setSize("");
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Units of sale</DialogTitle>
          <DialogDescription>
            Name the packs a product is sold in, with how much is in one. Demand can then be typed in cases,
            trays or pallets; it is stored in the product&apos;s base unit.
          </DialogDescription>
        </DialogHeader>
        <Select value={itemId} onValueChange={setItemId}>
          <SelectTrigger aria-label="Product">
            <SelectValue placeholder="Choose a product…" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {products.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name} <span className="font-mono text-xs text-muted-foreground">{p.code}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {item && (
          <>
            {mine.length === 0 ? (
              <p className="text-sm text-muted-foreground">No units of sale yet.</p>
            ) : (
              <ul className="flex flex-col divide-y rounded-md border">
                {mine.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span>
                      <span className="font-medium">{p.name}</span> = {formatNumber(p.size)} {base}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${p.name}`}
                      disabled={busy}
                      onClick={() => void send([{ name: p.name, size: null }], `${p.name} removed`)}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <form className="flex flex-wrap items-center gap-2" onSubmit={add}>
              <Input
                className="w-32"
                placeholder="Name (case)"
                aria-label="Pack name"
                maxLength={40}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <span className="text-sm text-muted-foreground">=</span>
              <Input
                className="w-24"
                inputMode="decimal"
                placeholder="Size"
                aria-label="Pack size"
                value={size}
                onChange={(e) => setSize(e.target.value)}
              />
              <Select value={unit || base} onValueChange={(v) => setUnit(v as UnitCode)}>
                <SelectTrigger className="w-24" aria-label="Size unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {unitsForItem(item).map((u) => (
                      <SelectItem key={u} value={u}>
                        {units[u].label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button type="submit" variant="outline" disabled={busy}>
                {busy && <Spinner data-icon="inline-start" />} Save
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
