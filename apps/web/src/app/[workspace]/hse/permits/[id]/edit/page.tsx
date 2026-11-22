import { getHsePermit, getWorkspaceToday } from "@/lib/api";
import { PermitEditor } from "../../../permit-editor";
export default async function Page({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const [permit, today] = await Promise.all([getHsePermit(slug, id), getWorkspaceToday(slug)]);
  return (
    <div className="flex-1 overflow-y-auto">
      <PermitEditor key={permit.revision} slug={slug} permit={permit} today={today} />
    </div>
  );
}
