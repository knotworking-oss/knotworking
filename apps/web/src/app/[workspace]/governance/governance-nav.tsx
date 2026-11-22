"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useWorkspace } from "@/lib/workspace-store";

/** Tabs across the Management review pages; Concerns only for managers. */
export function GovernanceNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  const manage = useWorkspace().can("governance", "manage");
  const base = `/${slug}/governance`;
  const tabs = [
    { href: base, label: "Overview" },
    { href: `${base}/reviews`, label: "Reviews" },
    { href: `${base}/objectives`, label: "Objectives" },
    { href: `${base}/culture`, label: "Culture plan" },
    { href: `${base}/requirements`, label: "Requirements" },
    { href: `${base}/standards`, label: "Standards" },
    ...(manage ? [{ href: `${base}/concerns`, label: "Concerns" }] : []),
  ];
  const active =
    [...tabs].reverse().find((t) => t.href !== base && pathname.startsWith(t.href))?.href ?? base;
  return (
    <Tabs value={active}>
      <TabsList className="flex-wrap">
        {tabs.map((t) => (
          <TabsTrigger key={t.href} value={t.href} asChild>
            <Link href={t.href}>{t.label}</Link>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** The page frame every Management review page shares. */
export function GovernanceFrame({
  slug,
  title,
  description,
  actions,
  children,
}: {
  slug: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-8">
      <GovernanceNav slug={slug} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

const NONE = "none";

/** Pick a workspace member (or nobody). */
export function MemberSelect({
  value,
  onChange,
  label,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  label: string;
}) {
  const { idx } = useWorkspace();
  const users = [...idx.boot.users].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={NONE}>Nobody</SelectItem>
          {users.map((u) => (
            <SelectItem key={u.id} value={u.id}>
              {u.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** A plain enum select. */
export function EnumSelect<T extends string>({
  value,
  onChange,
  options,
  labels,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly T[];
  labels: Record<T, string>;
  label: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {labels[o]}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
