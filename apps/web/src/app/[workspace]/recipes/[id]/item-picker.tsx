"use client";

import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@knotworking/ui/components/popover";
import { ChevronsUpDown } from "lucide-react";
import { useEffect, useState } from "react";
import type { Item } from "@/lib/api";
import { browserApi, unwrap } from "@/lib/auth-client";

/** What a recipe line needs to know about an item. */
export type PickedItem = Pick<Item, "id" | "code" | "name" | "unit" | "densityGPerMl" | "unitWeightG">;

/** Search-as-you-type picker over `GET /items` (active items only). */
export function ItemPicker({
  slug,
  value,
  excludeId,
  onChange,
}: {
  slug: string;
  value: PickedItem | null;
  /** An item that can't be chosen (the recipe's own output). */
  excludeId?: string;
  onChange: (item: PickedItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickedItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const page = await unwrap(
          browserApi().v1.workspaces[":slug"].items.$get({
            param: { slug },
            query: { ...(query.trim() ? { q: query.trim() } : {}), status: "active", limit: "20" },
          }),
        );
        if (!stale) setResults(page.items);
      } catch {
        if (!stale) setResults([]);
      } finally {
        if (!stale) setLoading(false);
      }
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, query, slug]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-between font-normal">
          <span className="truncate">{value ? `${value.code} · ${value.name}` : "Choose an item"}</span>
          <ChevronsUpDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2" align="start">
        <Input
          autoFocus
          placeholder="Search name or code"
          aria-label="Search items"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul className="mt-2 flex max-h-60 flex-col overflow-y-auto" aria-busy={loading}>
          {results
            .filter((item) => item.id !== excludeId)
            .map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    onChange(item);
                    setOpen(false);
                  }}
                >
                  <span className="font-mono text-xs">{item.code}</span> · {item.name}
                </button>
              </li>
            ))}
          {!loading && results.length === 0 && (
            <li className="px-2 py-3 text-center text-sm text-muted-foreground">No items found.</li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
