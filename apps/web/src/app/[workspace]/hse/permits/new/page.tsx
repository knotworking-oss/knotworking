import { getWorkspaceToday } from "@/lib/api";
import { PermitEditor } from "../../permit-editor";
export default async function Page({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  return (
    <div className="flex-1 overflow-y-auto">
      <PermitEditor slug={slug} today={await getWorkspaceToday(slug)} />
    </div>
  );
}
