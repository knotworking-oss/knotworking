import { redirect } from "next/navigation";

export default async function LegacyMaintenancePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  redirect(`/${workspace}/maintenance`);
}
