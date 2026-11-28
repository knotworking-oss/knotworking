import { hasModuleLevel } from "@knotworking/core";
import { Card } from "@knotworking/ui/components/card";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getSopOutstanding } from "@/lib/api";

export const metadata: Metadata = { title: "SOP acknowledgements outstanding" };

/** Who still has to read which SOP, by person (SOPs `manage`). */
export default async function OutstandingPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const boot = await getBootstrap(slug);
  if (!hasModuleLevel(boot.modules.find((m) => m.id === "sops")?.access, "manage")) notFound();
  const { items } = await getSopOutstanding(slug);
  const people = new Map<string, { name: string; items: typeof items }>();
  for (const item of items) {
    const entry = people.get(item.userId) ?? { name: item.name, items: [] };
    entry.items.push(item);
    people.set(item.userId, entry);
  }
  const sorted = [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/sops`} className="text-muted-foreground hover:text-foreground">
          SOPs
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="font-medium">Acknowledgements outstanding</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-4 py-8">
          <p className="text-sm text-muted-foreground">
            {items.length} outstanding across {sorted.length} people. Days count from when the current version
            took effect.
          </p>
          {sorted.length === 0 && (
            <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              Everyone has acknowledged every current SOP.
            </p>
          )}
          {sorted.map((p) => (
            <Card key={p.name} className="gap-2 p-4 text-sm">
              <h2 className="font-medium">
                {p.name} <span className="text-muted-foreground">({p.items.length})</span>
              </h2>
              <ul className="flex flex-col gap-1">
                {p.items.map((i) => (
                  <li key={i.versionId} className="flex justify-between gap-2">
                    <Link href={`/${slug}/sops/${i.sopId}`} className="hover:underline">
                      <span className="font-mono">{i.code}</span> {i.title} (v{i.versionNumber})
                    </Link>
                    <span
                      className={
                        i.daysOutstanding >= i.ackReminderDays ? "text-status-red" : "text-muted-foreground"
                      }
                    >
                      {i.daysOutstanding} days
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
