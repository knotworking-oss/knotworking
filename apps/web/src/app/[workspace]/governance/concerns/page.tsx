import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getGovernanceConcerns, requireModule } from "@/lib/api";
import { ConcernsBoard } from "./concerns-board";

export const metadata: Metadata = { title: "Confidential concerns" };

/** Managers only: 404 for anyone without manage on Governance. */
export default async function ConcernsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  await requireModule(slug, "governance", "manage");
  const { concerns } = await getGovernanceConcerns(slug);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Management review</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <ConcernsBoard slug={slug} concerns={concerns} />
      </div>
    </>
  );
}
