"use client";

import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useEffect, useState, type ReactNode } from "react";
import { SelectField } from "@/components/haccp-forms";
import { browserApi, unwrap } from "@/lib/auth-client";

/** A label and a value in a `<dl>` grid. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap">{children}</dd>
    </>
  );
}

/** A text value, or "Not recorded yet". */
export function TextRow({ label, value }: { label: string; value: string | null }) {
  return (
    <Row label={label}>{value ?? <span className="text-muted-foreground italic">Not recorded yet</span>}</Row>
  );
}

export const NONE = "none";

export const qualityApi = () => browserApi().v1.workspaces[":slug"].quality;

/** What the item picker needs. */
export interface ItemOption {
  id: string;
  code: string;
  name: string;
}

/** What the member pickers need. */
export interface MemberOption {
  userId: string;
  name: string;
}

/** Empty input → null, so a cleared field clears the value. */
export const orNull = (value: string) => value.trim() || null;

export function TextField({
  id,
  label,
  value,
  onChange,
  rows = 3,
  required = false,
  maxLength = 4000,
  placeholder,
  description,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
  description?: ReactNode;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {rows > 1 ? (
        <Textarea
          id={id}
          rows={rows}
          required={required}
          maxLength={maxLength}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          id={id}
          required={required}
          maxLength={maxLength}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}

export function DateField({
  id,
  label,
  value,
  onChange,
  required = true,
  min,
  max,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  min?: string;
  max?: string;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="date"
        required={required}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

export function MemberSelect({
  id,
  label,
  value,
  onChange,
  members,
  noneLabel = "Nobody",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  members: MemberOption[];
  noneLabel?: string;
}) {
  return (
    <SelectField
      id={id}
      label={label}
      value={value}
      onChange={onChange}
      options={[[NONE, noneLabel], ...members.map((m) => [m.userId, m.name] as const)]}
    />
  );
}

interface LotOption {
  id: string;
  lotCode: string;
}

const LOT_PAGE = 200;

/**
 * An item, then one of its lots: empty lots included (a complaint is often about stock long gone),
 * latest received first. Older lots are found by typing part of the code. Lots load when the item
 * or the search changes; the lot already chosen (`currentLot`) is always offered.
 */
export function ItemLotFields({
  slug,
  items,
  itemId,
  lotId,
  onItem,
  onLot,
  idPrefix,
  lotRequired = false,
  currentLot,
}: {
  slug: string;
  items: ItemOption[];
  itemId: string;
  lotId: string;
  onItem: (id: string) => void;
  onLot: (id: string) => void;
  idPrefix: string;
  lotRequired?: boolean;
  currentLot?: LotOption | null | undefined;
}) {
  const [lots, setLots] = useState<LotOption[] | null>(null);
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (itemId === NONE) {
      setLots(null);
      return;
    }
    let live = true;
    setLots(null);
    unwrap(
      browserApi().v1.workspaces[":slug"].stock.lots.$get({
        param: { slug },
        query: {
          itemId,
          includeEmpty: "true",
          order: "newest",
          limit: String(LOT_PAGE),
          ...(query ? { q: query } : {}),
        },
      }),
    )
      .then((page) => {
        if (!live) return;
        setLots(page.lots.map((l) => ({ id: l.id, lotCode: l.lotCode })));
        setMore(page.total > page.lots.length);
      })
      .catch(() => live && setLots([]));
    return () => {
      live = false;
    };
  }, [slug, itemId, query]);
  // The lot chosen stays an option when a later search no longer lists it.
  const [picked, setPicked] = useState<LotOption | null>(currentLot ?? null);
  const chosen = picked && picked.id === lotId ? picked : null;
  const shown = [...(chosen && !lots?.some((l) => l.id === chosen.id) ? [chosen] : []), ...(lots ?? [])];
  return (
    <>
      <SelectField
        id={`${idPrefix}-item`}
        label="Product or item"
        value={itemId}
        onChange={(v) => {
          onItem(v);
          onLot(NONE);
          setSearch("");
          setQuery("");
        }}
        options={[
          [NONE, lotRequired ? "Choose an item" : "Not known"],
          ...items.map((i) => [i.id, `${i.code} ${i.name}`] as const),
        ]}
      />
      <SelectField
        id={`${idPrefix}-lot`}
        label="Lot"
        value={lotId}
        onChange={(id) => {
          setPicked(shown.find((l) => l.id === id) ?? null);
          onLot(id);
        }}
        disabled={itemId === NONE || lots === null}
        options={[
          [
            NONE,
            itemId === NONE
              ? "Choose the item first"
              : lots === null
                ? "Loading…"
                : lotRequired
                  ? "Choose a lot"
                  : "Not known",
          ],
          ...shown.map((l) => [l.id, l.lotCode] as const),
        ]}
        description={
          more || query ? (
            <Input
              aria-label="Find a lot by code"
              placeholder={more ? `Latest ${LOT_PAGE} shown; type a lot code to find older ones` : "Lot code"}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          ) : undefined
        }
      />
    </>
  );
}
