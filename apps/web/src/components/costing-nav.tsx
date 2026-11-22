"use client";

import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** Tabs across the Costing pages. A batch's cost sits under Batches. */
export function CostingNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  const base = `/${slug}/costing`;
  const tabs = [
    { href: base, label: "Standard against actual" },
    { href: `${base}/batches`, label: "Batches" },
    { href: `${base}/valuation`, label: "Stock valuation" },
    { href: `${base}/setup`, label: "Rates and standard costs" },
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
