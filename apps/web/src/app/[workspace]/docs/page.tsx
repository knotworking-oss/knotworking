import { Card, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@knotworking/ui/components/empty";
import { FileText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { NewDocButton } from "@/components/new-doc-button";
import { PageHeader } from "@/components/page-header";
import { getBootstrap } from "@/lib/api";
import { formatShortDate } from "@/lib/format";

export const metadata: Metadata = { title: "Docs" };

export default async function DocsIndexPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const boot = await getBootstrap(slug);
  const top = boot.documents.filter((d) => !d.parentId);
  const childCount = (id: string) => boot.documents.filter((d) => d.parentId === id).length;

  return (
    <>
      <PageHeader actions={<NewDocButton />}>
        <h1 className="font-medium">Docs</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        {top.length === 0 && (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileText />
              </EmptyMedia>
              <EmptyTitle>No docs yet</EmptyTitle>
              <EmptyDescription>Write down plans, processes and notes for your team.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <NewDocButton />
            </EmptyContent>
          </Empty>
        )}
        <div className="grid gap-4 p-6 sm:grid-cols-2 xl:grid-cols-3">
          {top.map((d) => (
            <Link
              key={d.id}
              href={`/${slug}/docs/${d.id}`}
              className="rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardHeader>
                  <span className="mb-3 text-3xl leading-none">{d.icon ?? "📄"}</span>
                  <CardTitle>{d.title || "Untitled"}</CardTitle>
                  <CardDescription>
                    Updated {formatShortDate(d.updatedAt, boot.workspace.timeZone)}
                    {childCount(d.id) > 0 && ` · ${childCount(d.id)} pages`}
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
