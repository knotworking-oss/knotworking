import { getWorkspaceToday, getWorkspaceCurrency } from "@/lib/api";
import { SalesEditor } from "../sales-editor";
export default async function Page({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [today, currency] = await Promise.all([getWorkspaceToday(slug), getWorkspaceCurrency(slug)]);
  return (
    <div className="flex-1 overflow-y-auto">
      <SalesEditor slug={slug} today={today} currency={currency} />
    </div>
  );
}
