import { getWorkspaceToday } from "@/lib/api";
import { IncidentEditor } from "../../incident-editor";
export default async function Page({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  return (
    <div className="workspace-content flex-1 overflow-y-auto py-6">
      <IncidentEditor slug={slug} today={await getWorkspaceToday(slug)} />
    </div>
  );
}
