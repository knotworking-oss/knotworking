import type { Metadata } from "next";
import { HaccpHeader } from "@/components/haccp-header";
import { getHaccpReviewQueue, requireModule } from "@/lib/api";
import { ReviewBoard } from "./review-board";

export const metadata: Metadata = { title: "Readings awaiting review" };

/** CCP readings recorded through an API token, for a person with manage access to review. */
export default async function HaccpReviewPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  await requireModule(slug, "haccp", "manage");
  const { logs, total } = await getHaccpReviewQueue(slug);
  return (
    <>
      <HaccpHeader slug={slug} />
      <div className="flex-1 overflow-y-auto">
        <ReviewBoard slug={slug} logs={logs} total={total} />
      </div>
    </>
  );
}
