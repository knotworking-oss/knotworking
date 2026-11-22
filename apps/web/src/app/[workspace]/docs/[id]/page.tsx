import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@knotworking/ui/components/breadcrumb";
import { Button } from "@knotworking/ui/components/button";
import { UserAvatar } from "@knotworking/ui/components/user-avatar";
import { FileText, MessageSquare, MoreHorizontal, Star } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { Backlinks } from "@/components/backlinks";
import { DocAttachment } from "@/components/doc-attachment";
import { DocumentCover } from "@/components/document-cover";
import { DocumentEditor } from "@/components/document-editor";
import { NewDocButton } from "@/components/new-doc-button";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getDocument, getDocumentBacklinks } from "@/lib/api";
import { formatLongDate } from "@/lib/format";

type Props = { params: Promise<{ workspace: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { workspace, id } = await params;
  const doc = await getDocument(workspace, id);
  return { title: doc.title || "Untitled" };
}

export default async function DocumentPage({ params }: Props) {
  const { workspace: slug, id } = await params;
  const [boot, doc, backlinks] = await Promise.all([
    getBootstrap(slug),
    getDocument(slug, id),
    getDocumentBacklinks(slug, id),
  ]);
  const editor = boot.users.find((u) => u.id === doc.lastEditedById);

  return (
    <>
      <PageHeader
        actions={
          <>
            <span className="mr-2 hidden text-xs text-muted-foreground sm:inline">
              Edited {formatLongDate(doc.updatedAt, boot.workspace.timeZone)}
            </span>
            <NewDocButton parentId={doc.id} subpage />
            <Button variant="ghost" size="icon-sm" aria-label="Comments">
              <MessageSquare />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Favorite">
              <Star />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="More">
              <MoreHorizontal />
            </Button>
          </>
        }
      >
        <Breadcrumb>
          <BreadcrumbList>
            {doc.ancestors.map((a) => (
              <Fragment key={a.id}>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link href={`/${slug}/docs/${a.id}`}>
                      {a.icon} {a.title || "Untitled"}
                    </Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </Fragment>
            ))}
            <BreadcrumbItem>
              <BreadcrumbPage>
                {doc.icon} {doc.title || "Untitled"}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PageHeader>

      <div className="flex-1 overflow-y-auto">
        <article className="mx-auto flex max-w-3xl flex-col px-5 pt-8 pb-32 sm:px-12 sm:pt-16">
          <DocumentCover key={`${doc.id}:${doc.coverUrl}`} documentId={doc.id} coverUrl={doc.coverUrl} />
          {doc.icon && <div className="mb-4 text-6xl leading-none">{doc.icon}</div>}
          <DocumentEditor
            key={doc.id}
            id={doc.id}
            title={doc.title}
            content={doc.content}
            updatedAt={doc.updatedAt}
            parentId={doc.parentId}
            teamId={doc.teamId}
            projectId={doc.projectId}
            meta={
              <div className="mt-3 mb-8 flex flex-col gap-3">
                <div className="flex min-h-5 items-center gap-2 text-sm text-muted-foreground">
                  {editor && (
                    <>
                      <UserAvatar name={editor.name} className="size-5" />
                      <span>
                        Last edited by <span className="text-foreground">{editor.name}</span>
                      </span>
                    </>
                  )}
                </div>
                <DocAttachment id={doc.id} initial={{ teamId: doc.teamId, projectId: doc.projectId }} />
              </div>
            }
          />

          <Backlinks
            slug={slug}
            heading="Linked from"
            backlinks={backlinks}
            teamKeys={new Map(boot.teams.map((t) => [t.id, t.key]))}
          />

          {doc.children.length > 0 && (
            <div className="mt-8 flex flex-col gap-1">
              {doc.children.map((c) => (
                <Link
                  key={c.id}
                  href={`/${slug}/docs/${c.id}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 font-medium underline decoration-border underline-offset-4 hover:bg-muted"
                >
                  <span className="flex w-5 justify-center">
                    {c.icon ?? <FileText className="size-4 text-muted-foreground" />}
                  </span>
                  {c.title || "Untitled"}
                </Link>
              ))}
            </div>
          )}
        </article>
      </div>
    </>
  );
}
