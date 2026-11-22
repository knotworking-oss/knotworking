import type { DocContent, DocImageAttrs, DocNode } from "@knotworking/core";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { cn } from "@knotworking/ui/lib/utils";
import type { ReactNode } from "react";
import { AttachmentImage } from "./attachment-image";
import { MentionChip } from "./mention-chip";

/**
 * Read-only renderer for block content. Editing will use a ProseMirror-based
 * editor over the same JSON, so stored documents need no migration.
 */
export function DocRenderer({
  content,
  className,
  emptyText = "Empty page",
}: {
  content: DocContent | null | undefined;
  className?: string;
  emptyText?: string;
}) {
  if (!content?.content.length) return <p className="text-muted-foreground">{emptyText}</p>;
  return (
    <div className={cn("flex flex-col gap-1.5 text-[15px] leading-7", className)}>
      {content.content.map(renderBlock)}
    </div>
  );
}

function renderBlock(node: DocNode, key: number): ReactNode {
  const children = () => node.content?.map(renderBlock);
  switch (node.type) {
    case "paragraph":
      return (
        <p key={key} className="min-h-[1lh] py-0.5">
          {node.content?.map(renderInline)}
        </p>
      );
    case "heading": {
      const level = Number(node.attrs?.level ?? 2);
      const styles =
        {
          1: "mt-8 mb-1 text-3xl font-bold tracking-tight",
          2: "mt-6 mb-0.5 text-2xl font-semibold tracking-tight",
          3: "mt-4 text-base font-semibold",
        }[level] ?? "mt-4 text-base font-semibold";
      const Tag = `h${Math.min(Math.max(level, 1), 3) + 1}` as "h2" | "h3" | "h4";
      return (
        <Tag key={key} className={cn(styles, "first:mt-0")}>
          {node.content?.map(renderInline)}
        </Tag>
      );
    }
    case "bulletList":
      return (
        <ul key={key} className="list-disc pl-6 marker:text-muted-foreground">
          {children()}
        </ul>
      );
    case "orderedList":
      return (
        <ol key={key} className="list-decimal pl-6 marker:text-muted-foreground">
          {children()}
        </ol>
      );
    case "listItem":
      return (
        <li key={key} className="pl-1">
          {children()}
        </li>
      );
    case "taskList":
      return (
        <ul key={key} className="flex flex-col">
          {children()}
        </ul>
      );
    case "taskItem": {
      const checked = Boolean(node.attrs?.checked);
      return (
        <li key={key} className="flex items-start gap-2">
          <Checkbox checked={checked} disabled aria-readonly className="mt-1.5 disabled:opacity-100" />
          <div className={cn("flex-1", checked && "text-muted-foreground line-through")}>{children()}</div>
        </li>
      );
    }
    case "blockquote":
      return (
        <blockquote key={key} className="my-1 border-l-2 border-border pl-4 text-muted-foreground italic">
          {children()}
        </blockquote>
      );
    case "callout":
      return (
        <div key={key} className="my-1 flex gap-3 rounded-md bg-muted px-4 py-3">
          <span aria-hidden className="text-xl leading-7">
            {String(node.attrs?.emoji ?? "💡")}
          </span>
          <div className="flex-1">{children()}</div>
        </div>
      );
    case "codeBlock":
      return (
        <pre key={key} className="my-1 overflow-x-auto rounded-md bg-muted p-4 font-mono text-sm leading-6">
          <code>{node.content?.map((n) => n.text).join("")}</code>
        </pre>
      );
    case "table":
      return (
        <div key={key} className="my-1 max-w-full overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <tbody>{children()}</tbody>
          </table>
        </div>
      );
    case "tableRow":
      return <tr key={key}>{children()}</tr>;
    case "tableHeader":
    case "tableCell": {
      const header = node.type === "tableHeader";
      const span = (value: unknown) =>
        Number.isInteger(value) && Number(value) > 1 ? Number(value) : undefined;
      const Cell = header ? "th" : "td";
      return (
        <Cell
          key={key}
          colSpan={span(node.attrs?.colspan)}
          rowSpan={span(node.attrs?.rowspan)}
          className={cn(
            "min-w-20 border border-border px-3 py-1.5 align-top",
            header && "bg-muted text-left font-semibold",
          )}
        >
          {children()}
        </Cell>
      );
    }
    case "horizontalRule":
      return <hr key={key} className="my-4 border-border" />;
    case "image": {
      const attrs = (node.attrs ?? {}) as Partial<DocImageAttrs>;
      if (!attrs.attachmentId) return null;
      return (
        <AttachmentImage
          key={key}
          attachmentId={attrs.attachmentId}
          filename={attrs.filename}
          alt={attrs.alt}
        />
      );
    }
    default:
      return <div key={key}>{children()}</div>;
  }
}

function renderInline(node: DocNode, key: number): ReactNode {
  if (node.type === "hardBreak") return <br key={key} />;
  if (node.type === "mention")
    return (
      <MentionChip
        key={key}
        kind={String(node.attrs?.kind ?? "")}
        id={String(node.attrs?.id ?? "")}
        label={typeof node.attrs?.label === "string" ? node.attrs.label : undefined}
      />
    );
  let el: ReactNode = node.text ?? null;
  for (const mark of node.marks ?? []) {
    if (mark.type === "bold") el = <strong className="font-semibold">{el}</strong>;
    else if (mark.type === "italic") el = <em>{el}</em>;
    else if (mark.type === "strike") el = <s>{el}</s>;
    else if (mark.type === "highlight")
      el = <mark className="rounded-xs bg-label-yellow-bg px-0.5">{el}</mark>;
    else if (mark.type === "code")
      el = (
        <code className="rounded-xs bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{el}</code>
      );
    else if (mark.type === "link")
      el = (
        <a
          href={String(mark.attrs?.href ?? "#")}
          className="underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground"
        >
          {el}
        </a>
      );
  }
  return <span key={key}>{el}</span>;
}
