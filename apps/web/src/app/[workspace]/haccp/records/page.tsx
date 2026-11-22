import type { Metadata } from "next";
import { HaccpHeader } from "@/components/haccp-header";
import {
  getCalibrationRecords,
  getCleaningRecords,
  getHaccpAssets,
  getHaccpDue,
  getMembers,
} from "@/lib/api";
import { RecordsBoard } from "./records-board";

export const metadata: Metadata = { title: "Cleaning and calibration" };

export default async function HaccpRecordsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ assets }, cleaning, calibration, due, { members }] = await Promise.all([
    getHaccpAssets(slug),
    getCleaningRecords(slug),
    getCalibrationRecords(slug),
    getHaccpDue(slug, "all"),
    getMembers(slug),
  ]);
  return (
    <>
      <HaccpHeader slug={slug} />
      <div className="flex-1 overflow-y-auto">
        <RecordsBoard
          slug={slug}
          assets={assets}
          cleaning={cleaning.records}
          calibration={calibration.records}
          checks={due.checks.filter((c) => c.kind !== "ccp")}
          members={members.filter((m) => !m.deactivatedAt).map((m) => ({ id: m.userId, name: m.name }))}
        />
      </div>
    </>
  );
}
