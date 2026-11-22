import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import {
  getAttendanceSettings,
  getBootstrap,
  getKioskBadges,
  getKioskDevices,
  getKioskRejections,
} from "@/lib/api";
import { KioskBadges, RefusedKioskEvents } from "./kiosk-extras";
import { AttendanceSettingsView } from "./settings-view";

export const metadata: Metadata = { title: "Attendance settings" };

export default async function AttendanceSettingsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [settings, { devices }, { people }, { rejections }, bootstrap] = await Promise.all([
    getAttendanceSettings(slug),
    getKioskDevices(slug),
    getKioskBadges(slug),
    getKioskRejections(slug),
    getBootstrap(slug),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Attendance</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <AttendanceSettingsView
          slug={slug}
          settings={settings}
          devices={devices}
          extras={
            <>
              <RefusedKioskEvents slug={slug} rejections={rejections} />
              <KioskBadges slug={slug} workspaceName={bootstrap.workspace.name} people={people} />
            </>
          }
        />
      </div>
    </>
  );
}
