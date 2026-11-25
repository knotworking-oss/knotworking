import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import {
  canReadModule,
  getCalibrationInstruments,
  getMembers,
  getMaintenanceAssets,
  getMaintenanceRecords,
  getMaintenanceTasks,
  getSiteAreas,
  getWorkOrders,
} from "@/lib/api";
import { MaintenanceBoard } from "./maintenance-board";

export const metadata: Metadata = { title: "Planned maintenance" };

export default async function MaintenancePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  // Calibration instruments are HACCP's records: shown only when the viewer can read HACCP.
  const calibration = await canReadModule(slug, "haccp");
  const [{ assets }, { tasks }, { records }, { areas }, { workOrders }, { instruments }, { members }] =
    await Promise.all([
      getMaintenanceAssets(slug),
      getMaintenanceTasks(slug),
      getMaintenanceRecords(slug),
      getSiteAreas(slug),
      getWorkOrders(slug),
      calibration ? getCalibrationInstruments(slug) : { instruments: [] },
      getMembers(slug),
    ]);
  return (
    <>
      <SiteHeader slug={slug} />
      <div className="flex-1 overflow-y-auto">
        <MaintenanceBoard
          slug={slug}
          assets={assets}
          tasks={tasks}
          records={records}
          areas={areas}
          workOrders={workOrders}
          instruments={instruments}
          calibration={calibration}
          members={members.filter((m) => !m.deactivatedAt).map((m) => ({ id: m.userId, name: m.name }))}
        />
      </div>
    </>
  );
}
