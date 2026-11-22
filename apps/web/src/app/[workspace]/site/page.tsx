import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import { getSiteDue } from "@/lib/api";
import { DueBoard } from "./due-board";

export const metadata: Metadata = { title: "Site programmes" };

export default async function SitePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const due = await getSiteDue(slug, "all");
  return (
    <>
      <SiteHeader slug={slug} />
      <div className="flex-1 overflow-y-auto">
        <DueBoard slug={slug} due={due} />
      </div>
    </>
  );
}
