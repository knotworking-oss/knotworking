import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import { getGlassBreakages, getGlassChecks, getGlassItems, getSiteAreas } from "@/lib/api";
import { GlassBoard } from "./glass-board";

export const metadata: Metadata = { title: "Glass and brittle plastics" };

export default async function GlassPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ items }, { breakages }, { areas }, { checks }] = await Promise.all([
    getGlassItems(slug),
    getGlassBreakages(slug),
    getSiteAreas(slug),
    getGlassChecks(slug),
  ]);
  return (
    <>
      <SiteHeader slug={slug} />
      <div className="flex-1 overflow-y-auto">
        <GlassBoard slug={slug} items={items} breakages={breakages} areas={areas} checks={checks} />
      </div>
    </>
  );
}
