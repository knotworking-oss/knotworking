import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getManagementReview } from "@/lib/api";
import { ReviewDetail } from "./review-detail";

export const metadata: Metadata = { title: "Management review" };

export default async function ReviewPage({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const review = await getManagementReview(slug, id);
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/governance/reviews`}>Management reviews</Link>
        <span>/</span>
        <h1 className="font-medium">{review.title}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <ReviewDetail slug={slug} review={review} />
      </div>
    </>
  );
}
