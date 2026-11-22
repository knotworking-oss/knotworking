"use client";

import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** Tabs across the Food defence pages. */
export function DefenceNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  const base = `/${slug}/defence`;
  const tabs = [
    { href: base, label: "Overview" },
    { href: `${base}/assessments`, label: "Assessments" },
    { href: `${base}/controls`, label: "Controls and checks" },
    { href: `${base}/exercises`, label: "Exercises" },
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

/** The page frame every Food defence page shares. */
export function DefenceFrame({
  slug,
  title,
  description,
  actions,
  children,
}: {
  slug: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-8">
      <DefenceNav slug={slug} />
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
