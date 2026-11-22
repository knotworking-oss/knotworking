import { getWorkspaceToday } from "@/lib/api";
import { RegisterEditor } from "../../register-editor";
export default async function Page({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  return (
    <div className="flex-1 overflow-y-auto">
      <RegisterEditor slug={slug} today={await getWorkspaceToday(slug)} />
    </div>
  );
}
