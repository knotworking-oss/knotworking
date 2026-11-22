"use client";

import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-store";

/** Tabs across the Attendance pages, by what the viewer may see. */
export function AttendanceNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  const { can } = useWorkspace();
  const base = `/${slug}/attendance`;
  const tabs = [
    { href: base, label: "On site" },
    ...(can("attendance", "write") ? [{ href: `${base}/shifts`, label: "Shifts" }] : []),
    ...(can("attendance", "manage")
      ? [
          { href: `${base}/payroll`, label: "Payroll" },
          { href: `${base}/settings`, label: "Settings & kiosks" },
        ]
      : []),
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
