"use client";

import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-store";

/** Tabs across the Training pages. Sign-off is only shown to managers. */
export function TrainingNav({ slug, pendingCount }: { slug: string; pendingCount?: number }) {
  const pathname = usePathname();
  const { can } = useWorkspace();
  const base = `/${slug}/training`;
  const tabs = [
    { href: base, label: "Matrix" },
    { href: `${base}/due`, label: "Due" },
    ...(can("training", "manage")
      ? [{ href: `${base}/sign-off`, label: pendingCount ? `Sign-off (${pendingCount})` : "Sign-off" }]
      : []),
    { href: `${base}/courses`, label: "Courses" },
  ];
  const active = [...tabs]
    .reverse()
    .find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`))?.href;
  return (
    <Tabs value={active ?? base}>
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
