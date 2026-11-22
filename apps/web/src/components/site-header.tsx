import { PageHeader } from "@/components/page-header";
import { SiteNav } from "@/components/site-nav";
import { getSiteDue } from "@/lib/api";

/** The site pages' header: their navigation, with how many things wait for a person on each tab. */
export async function SiteHeader({ slug }: { slug: string }) {
  const { counts } = await getSiteDue(slug, "due");
  return (
    <PageHeader>
      <SiteNav
        slug={slug}
        waiting={{
          "/glass": counts.openBreakages,
          "/maintenance": counts.awaitingClearance,
          "/storage": counts.awaitingReview + counts.openActions,
          "/checks": counts.awaitingSignOff,
        }}
      />
    </PageHeader>
  );
}
