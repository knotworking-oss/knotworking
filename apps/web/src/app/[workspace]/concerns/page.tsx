import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getMyConcerns } from "@/lib/api";
import { RaiseConcern } from "./raise-concern";

export const metadata: Metadata = { title: "Raise a concern" };

/** Open to every member while the Governance module is on, whatever their module access. */
export default async function RaiseConcernPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const boot = await getBootstrap(slug);
  if (!boot.modules.some((m) => m.id === "governance")) notFound();
  const { concerns } = await getMyConcerns(slug);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Raise a concern</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <RaiseConcern slug={slug} concerns={concerns} />
      </div>
    </>
  );
}
