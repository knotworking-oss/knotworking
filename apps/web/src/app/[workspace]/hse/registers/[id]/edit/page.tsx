import { getHseRecord, getWorkspaceToday } from "@/lib/api";
import { RegisterEditor } from "../../../register-editor";
export default async function Page({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const [record, today] = await Promise.all([getHseRecord(slug, id), getWorkspaceToday(slug)]);
  return (
    <div className="flex-1 overflow-y-auto">
      <RegisterEditor key={record.revision} slug={slug} today={today} record={record} />
    </div>
  );
}
