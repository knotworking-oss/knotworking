import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import {
  getCalibrationInstruments,
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
  const [{ assets }, { tasks }, { records }, { areas }, { workOrders }, { instruments }] = await Promise.all([
    getMaintenanceAssets(slug),
    getMaintenanceTasks(slug),
    getMaintenanceRecords(slug),
    getSiteAreas(slug),
    getWorkOrders(slug),
    getCalibrationInstruments(slug),
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
        />
      </div>
    </>
  );
}
