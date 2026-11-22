import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import { getPestDevices, getPestTrends, getPestVisits, getSiteAreas } from "@/lib/api";
import { PestBoard } from "./pest-board";

export const metadata: Metadata = { title: "Pest control" };

export default async function PestPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ devices }, { visits }, { areas }, device, area, pest] = await Promise.all([
    getPestDevices(slug),
    getPestVisits(slug),
    getSiteAreas(slug),
    getPestTrends(slug, "device"),
    getPestTrends(slug, "area"),
    getPestTrends(slug, "pest"),
  ]);
  return (
    <>
      <SiteHeader slug={slug} />
      <div className="flex-1 overflow-y-auto">
        <PestBoard
          slug={slug}
          devices={devices}
          visits={visits}
          areas={areas}
          trends={{ device, area, pest }}
        />
      </div>
    </>
  );
}
