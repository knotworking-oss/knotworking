import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import { getSiteActions, getSiteAreas, getStorageReadings, getStorageUnits } from "@/lib/api";
import { StorageBoard } from "./storage-board";

export const metadata: Metadata = { title: "Storage temperatures" };

export default async function StoragePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ units }, { readings }, { actions }, { areas }] = await Promise.all([
    getStorageUnits(slug),
    getStorageReadings(slug),
    getSiteActions(slug, "open"),
    getSiteAreas(slug),
  ]);
  return (
    <>
      <SiteHeader slug={slug} />
      <div className="flex-1 overflow-y-auto">
        <StorageBoard slug={slug} units={units} readings={readings} actions={actions} areas={areas} />
      </div>
    </>
  );
}
