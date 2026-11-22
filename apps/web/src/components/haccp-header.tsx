import { HaccpNav } from "@/components/haccp-nav";
import { ModuleDashboardsLink } from "@/components/module-dashboards-link";
import { PageHeader } from "@/components/page-header";
import { getHaccpAwaitingReviewCount } from "@/lib/api";

/** The food safety pages' header: their navigation, with how many readings await review. */
export async function HaccpHeader({ slug }: { slug: string }) {
  const awaitingReview = await getHaccpAwaitingReviewCount(slug);
  return (
    <PageHeader actions={<ModuleDashboardsLink module="haccp" />}>
      <HaccpNav slug={slug} awaitingReview={awaitingReview} />
    </PageHeader>
  );
}
