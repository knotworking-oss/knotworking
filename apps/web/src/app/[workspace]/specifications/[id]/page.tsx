import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getSpecification, getSpecificationImpact } from "@/lib/api";
import { SpecificationDetail } from "./specification-detail";

export const metadata: Metadata = { title: "Specification" };

export default async function SpecificationPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [specification, impact] = await Promise.all([
    getSpecification(slug, id),
    getSpecificationImpact(slug, id),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">{specification.code}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <SpecificationDetail slug={slug} specification={specification} impact={impact} />
      </div>
    </>
  );
}
