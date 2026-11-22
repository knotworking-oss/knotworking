import { getSalesOrder, getWorkspaceToday } from "@/lib/api";
import { SalesEditor } from "../../sales-editor";
export default async function Page({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const [order, today] = await Promise.all([getSalesOrder(slug, id), getWorkspaceToday(slug)]);
  return (
    <div className="flex-1 overflow-y-auto">
      <SalesEditor
        key={`${id}-${order.revision}`}
        slug={slug}
        today={today}
        currency={order.currency}
        order={order}
      />
    </div>
  );
}
