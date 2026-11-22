import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { canReadModule, getHaccpAssets, getProductionDevices, getProductionLines } from "@/lib/api";
import { DevicesView } from "./devices-view";

export const metadata: Metadata = { title: "Devices" };

export default async function DevicesPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ devices }, { lines }, haccp] = await Promise.all([
    getProductionDevices(slug),
    getProductionLines(slug),
    canReadModule(slug, "haccp"),
  ]);
  // Equipment from the HACCP schedule, whose calibration gives a device's state (HACCP readers).
  const equipment = haccp
    ? (await getHaccpAssets(slug)).assets
        .filter((a) => a.kind === "equipment" && a.status === "active")
        .map((a) => ({ id: a.id, name: a.code ? `${a.code} ${a.name}` : a.name }))
    : [];
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Devices</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <DevicesView
          slug={slug}
          devices={devices}
          lines={lines.filter((l) => l.active).map((l) => ({ id: l.id, name: l.name }))}
          equipment={equipment}
        />
      </div>
    </>
  );
}
