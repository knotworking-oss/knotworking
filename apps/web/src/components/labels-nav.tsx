"use client";

import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** Tabs across the Labels pages. A label's page sits under Labels. */
export function LabelsNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  const base = `/${slug}/labels`;
  const tabs = [
    { href: base, label: "Labels" },
    { href: `${base}/nutrition`, label: "Ingredient nutrition" },
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
