import type { Metadata } from "next";
import { HaccpHeader } from "@/components/haccp-header";
import { getHaccpPlans, getHaccpTemplates } from "@/lib/api";
import { PlansManager } from "./plans-manager";

export const metadata: Metadata = { title: "HACCP plans" };

export default async function HaccpPlansPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const status = search.status === "all" ? "all" : "active";
  const [{ plans }, { templates }] = await Promise.all([
    getHaccpPlans(slug, status),
    getHaccpTemplates(slug),
  ]);
  return (
    <>
      <HaccpHeader slug={slug} />
      <div className="flex-1 overflow-y-auto">
        <PlansManager
          slug={slug}
          plans={plans}
          templates={templates.map((t) => ({ id: t.id, name: t.name }))}
          showArchived={status === "all"}
        />
      </div>
    </>
  );
}
