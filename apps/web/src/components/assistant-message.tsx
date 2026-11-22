"use client";

import { assistantToolLabel, type AssistantPart } from "@knotworking/core";
import { Spinner } from "@knotworking/ui/components/spinner";
import { cn } from "@knotworking/ui/lib/utils";
import { Check, ChevronRight, CircleAlert, Wrench } from "lucide-react";
import Link from "next/link";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { parseMarkdown, type Inline } from "@/lib/assistant-markdown";
import type { AssistantMessage } from "@/lib/assistant-store";

/** One message in the assistant sidebar: the person's prompt, or the agent's reply as it streams. */
export function AssistantMessageView({
  message,
}: {
  message: Pick<AssistantMessage, "role" | "text" | "parts" | "status" | "error">;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
          {message.text}
        </div>
      </div>
    );
  }
  const empty = message.parts.length === 0;
  return (
    <div className="flex flex-col gap-2 text-sm">
      {message.parts.map((part, i) =>
        part.type === "text" ? (
          <AssistantText key={i} text={part.text} />
        ) : (
          <ToolCall key={part.id} part={part} />
        ),
      )}
      {message.status === "running" && (
        <div className="flex items-center gap-2 text-muted-foreground" aria-live="polite">
          <Spinner className="size-3.5" />
          <span className="text-xs">{empty ? "Thinking…" : "Working…"}</span>
        </div>
      )}
      {message.status === "cancelled" && <p className="text-xs text-muted-foreground">Stopped.</p>}
      {message.status === "error" && (
        <p className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          <span>{message.error ?? "Something went wrong."}</span>
        </p>
      )}
    </div>
  );
}

function AssistantText({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="flex flex-col gap-2 leading-relaxed break-words">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "paragraph":
            return (
              <p key={i} className="whitespace-pre-wrap">
                {renderInline(b.children)}
              </p>
            );
          case "heading":
            return (
              <p key={i} className={cn("font-semibold", b.level === 1 && "text-base")}>
                {renderInline(b.children)}
              </p>
            );
          case "list": {
            const List = b.ordered ? "ol" : "ul";
            return (
              <List
                key={i}
                className={cn("flex flex-col gap-1 pl-5", b.ordered ? "list-decimal" : "list-disc")}
              >
                {b.items.map((item, j) => (
                  <li key={j}>{renderInline(item)}</li>
                ))}
              </List>
            );
          }
          case "code":
            return (
              <pre key={i} className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
                <code>{b.text}</code>
              </pre>
            );
        }
      })}
    </div>
  );
}

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return <Fragment key={i}>{n.text}</Fragment>;
      case "code":
        return (
          <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
            {n.text}
          </code>
        );
      case "strong":
        return <strong key={i}>{renderInline(n.children)}</strong>;
      case "link":
        return n.href.startsWith("/") ? (
          <Link key={i} href={n.href} className="underline underline-offset-4">
            {renderInline(n.children)}
          </Link>
        ) : (
          <a
            key={i}
            href={n.href}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-4"
          >
            {renderInline(n.children)}
          </a>
        );
    }
  });
}

/** A tool the agent called, collapsed to one line; open it to see the input and result. */
function ToolCall({ part }: { part: Extract<AssistantPart, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-muted-foreground hover:text-foreground"
      >
        {part.status === "running" ? (
          <Spinner className="size-3.5" />
        ) : part.status === "error" ? (
          <CircleAlert className="size-3.5 text-destructive" />
        ) : (
          <Check className="size-3.5 text-status-completed" />
        )}
        <Wrench className="size-3" />
        <span className="flex-1 truncate">{assistantToolLabel(part.name)}</span>
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 border-t px-2.5 py-2">
          <pre className="overflow-x-auto font-mono whitespace-pre-wrap text-muted-foreground">
            {part.input}
          </pre>
          {part.output !== undefined && (
            <pre
              className={cn(
                "max-h-48 overflow-auto font-mono whitespace-pre-wrap",
                part.status === "error" && "text-destructive",
              )}
            >
              {part.output || "(no output)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
