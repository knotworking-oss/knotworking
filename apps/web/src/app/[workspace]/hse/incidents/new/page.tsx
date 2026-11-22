import { getWorkspaceToday } from "@/lib/api";
import { IncidentEditor } from "../../incident-editor";
export default async function Page({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  return (
    <div className="mx-auto w-full max-w-4xl flex-1 overflow-y-auto p-6">
      <IncidentEditor slug={slug} today={await getWorkspaceToday(slug)} />
    </div>
  );
}
