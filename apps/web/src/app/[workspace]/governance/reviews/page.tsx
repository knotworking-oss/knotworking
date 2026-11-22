import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getManagementReviews } from "@/lib/api";
import { ReviewsBoard } from "./reviews-board";

export const metadata: Metadata = { title: "Management reviews" };

export default async function ReviewsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { reviews } = await getManagementReviews(slug);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Management review</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <ReviewsBoard slug={slug} reviews={reviews} />
      </div>
    </>
  );
}
