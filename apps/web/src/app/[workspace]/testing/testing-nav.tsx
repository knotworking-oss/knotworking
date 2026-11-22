"use client";

import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** Tabs across the Testing pages. */
export function TestingNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  const base = `/${slug}/testing`;
  const tabs = [
    { href: base, label: "Samples" },
    { href: `${base}/due`, label: "Due" },
    { href: `${base}/trends`, label: "Trends" },
    { href: `${base}/setup`, label: "Setup" },
  ];
  const active =
    [...tabs].reverse().find((t) => t.href !== base && pathname.startsWith(t.href))?.href ?? base;
  return (
    <Tabs value={active}>
      <TabsList>
        {tabs.map((t) => (
          <TabsTrigger key={t.href} value={t.href} asChild>
            <Link href={t.href}>{t.label}</Link>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
