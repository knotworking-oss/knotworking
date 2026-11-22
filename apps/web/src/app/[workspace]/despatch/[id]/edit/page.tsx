import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { getDespatch, getWorkspaceToday, requireModule } from "@/lib/api";
import { DespatchEditor } from "../../despatch-editor";
export default async function EditDespatchPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  await requireModule(slug, "despatch", "write");
  const initial = await getDespatch(slug, id);
  if (initial.status !== "draft") notFound();
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Edit {initial.reference}</h1>
      </PageHeader>
      <DespatchEditor slug={slug} today={await getWorkspaceToday(slug)} initial={initial} />
    </>
  );
}
