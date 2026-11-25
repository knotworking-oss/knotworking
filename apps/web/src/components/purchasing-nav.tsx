"use client";

import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOptionalWorkspace } from "@/lib/workspace-store";

/** Tabs across the Purchasing pages. An order's page sits under Orders. */
export function PurchasingNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  const store = useOptionalWorkspace();
  const base = `/${slug}/purchasing`;
  const tabs = [
    { href: base, label: "Orders" },
    { href: `${base}/invoices`, label: "Invoices" },
    { href: `${base}/credit-notes`, label: "Credit notes" },
    { href: `${base}/prices`, label: "Price lists" },
    // From production's material shortfall: only where Production is on and readable.
    ...(store?.can("production") ? [{ href: `${base}/suggestions`, label: "Suggestions" }] : []),
    { href: `${base}/suppliers`, label: "Supplier performance" },
  ];
  const active = [...tabs]
    .reverse()
    .find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`))?.href;
  return (
    <Tabs value={active ?? base}>
      <TabsList className="max-w-full overflow-x-auto">
        {tabs.map((t) => (
          <TabsTrigger key={t.href} value={t.href} asChild>
            <Link href={t.href}>{t.label}</Link>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
