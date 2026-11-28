import type { Metadata } from "next";
import Link from "next/link";
import { CustomFieldSettings } from "@/components/custom-field-settings";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Custom fields" };

export default async function CustomFieldsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  return (
    <>
      <PageHeader>
        <div className="flex items-center gap-2">
          <Link
            className="text-sm text-muted-foreground hover:underline"
            href={`/${workspace}/my-tasks/views`}
          >
            Views
          </Link>
          <span aria-hidden="true">/</span>
          <h1 className="font-medium">Custom fields</h1>
        </div>
      </PageHeader>
      <div className="flex-1 overflow-auto">
        <CustomFieldSettings />
      </div>
    </>
  );
}
