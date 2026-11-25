"use client";

import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import Link from "next/link";
import { useOptionalWorkspace } from "@/lib/workspace-store";
import { usePathname } from "next/navigation";

/** Tabs across the Quality pages. */
export function QualityNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  const store = useOptionalWorkspace();
  const base = `/${slug}/quality`;
  const tabs = [
    { href: base, label: "Overview" },
    { href: `${base}/complaints`, label: "Complaints" },
    { href: `${base}/nonconformances`, label: "Non-conformances" },
    { href: `${base}/audits`, label: "Audits" },
    // Item- and stock-centric parts need those modules (soft dependencies of Quality).
    ...(store?.can("items") ? [{ href: `${base}/authenticity`, label: "Authenticity" }] : []),
    ...(store?.can("stock") ? [{ href: `${base}/recall-tests`, label: "Recall tests" }] : []),
    ...(store?.can("despatch") && store?.can("production")
      ? [{ href: `${base}/incidents`, label: "Live cases" }]
      : []),
    ...(store?.can("items") ? [{ href: `${base}/trends`, label: "Trends" }] : []),
    { href: `${base}/records`, label: "Audit records" },
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
