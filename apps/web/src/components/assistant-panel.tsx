"use client";

import { assistantProviderNames } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@knotworking/ui/components/dropdown-menu";
import { Kbd, KbdGroup } from "@knotworking/ui/components/kbd";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@knotworking/ui/components/sheet";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useIsMobile } from "@knotworking/ui/hooks/use-mobile";
import { cn } from "@knotworking/ui/lib/utils";
import { ArrowUp, Check, ChevronDown, History, Plus, Sparkles, Square, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useAssistant } from "@/lib/assistant-store";
import { relativeTime } from "@/lib/relative-time";
import { AssistantMessageView } from "./assistant-message";

/**
 * The assistant sidebar: a chat with an AI model through the person's own API key, beside every
 * workspace page. A right-hand column on desktop, a sheet on phones. ⌘J toggles it.
 */
export function AssistantPanel({ slug }: { slug: string }) {
  const { enabled, open, setOpen } = useAssistant();
  const isMobile = useIsMobile();
  if (!enabled) return null;
  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-md">
          <SheetTitle className="sr-only">Assistant</SheetTitle>
          <SheetDescription className="sr-only">Chat with your AI assistant</SheetDescription>
          <AssistantChat slug={slug} />
        </SheetContent>
      </Sheet>
    );
  }
  if (!open) return null;
  return (
    <aside aria-label="Assistant" className="flex h-dvh w-[400px] shrink-0 flex-col border-l bg-background">
      <AssistantChat slug={slug} />
    </aside>
  );
}

function AssistantChat({ slug }: { slug: string }) {
  const { messages, loading, busy, error, send, stop, setOpen, newChat, conversationId } = useAssistant();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [conversationId]);
  // Keep the newest message in view as replies stream in.
  const last = messages[messages.length - 1];
  const lastLength = last ? last.parts.reduce((n, p) => n + (p.type === "text" ? p.text.length : 1), 0) : 0;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, lastLength]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy || sending) return;
    setSending(true);
    if (await send(text)) setDraft("");
    setSending(false);
    inputRef.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
    if (e.key === "Escape" && !draft) setOpen(false);
  };

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <Sparkles className="ml-1 size-4 text-muted-foreground" />
        <ConversationPicker />
        <div className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" onClick={newChat} aria-label="New chat" title="New chat">
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setOpen(false)}
            aria-label="Close assistant"
            title="Close (⌘J)"
          >
            <X />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : messages.length === 0 ? (
          <Welcome slug={slug} onPick={(text) => setDraft(text)} />
        ) : (
          <div className="flex flex-col gap-5">
            {messages.map((m) => (
              <AssistantMessageView key={m.id} message={m} />
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="shrink-0 border-t p-3">
        <ModelLine slug={slug} />
        {error && (
          <p className="mb-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">{error}</p>
        )}
        <form onSubmit={submit} className="relative">
          <Textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about this page, or anything in the workspace…"
            aria-label="Message the assistant"
            rows={2}
            className="max-h-48 min-h-16 resize-none pr-11"
          />
          {busy ? (
            <Button
              type="button"
              size="icon-sm"
              variant="secondary"
              className="absolute right-2 bottom-2"
              onClick={() => void stop()}
              aria-label="Stop"
              title="Stop"
            >
              <Square className="fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon-sm"
              className="absolute right-2 bottom-2"
              disabled={!draft.trim() || sending}
              aria-label="Send"
              title="Send (Enter)"
            >
              {sending ? <Spinner /> : <ArrowUp />}
            </Button>
          )}
        </form>
      </div>
    </>
  );
}

function ConversationPicker() {
  const { conversations, conversationId, selectConversation, deleteConversation } = useAssistant();
  const current = conversations.find((c) => c.id === conversationId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="max-w-56 min-w-0 font-medium">
          <span className="truncate">{current?.title ?? "New chat"}</span>
          <ChevronDown className="shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <History className="size-3.5" /> Recent chats
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {conversations.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">No chats yet.</p>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            {conversations.map((c) => (
              <DropdownMenuItem
                key={c.id}
                onSelect={() => selectConversation(c.id)}
                className={cn("group gap-2", c.id === conversationId && "bg-muted")}
              >
                <span className="flex-1 truncate">{c.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(c.updatedAt)}</span>
                <button
                  type="button"
                  aria-label={`Delete "${c.title}"`}
                  className="hidden text-muted-foreground group-hover:block hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    void deleteConversation(c.id);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Which provider and model this chat uses, with a menu to change them; or a nudge to add a key. */
function ModelLine({ slug }: { slug: string }) {
  const { keys, provider, model, setProvider, setModel, loadModels } = useAssistant();
  const [models, setModels] = useState<string[] | null>(null);
  if (keys === null) return null;
  if (keys.length === 0) {
    return (
      <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/40" aria-hidden />
        No API key yet.{" "}
        <Link href={`/${slug}/settings/assistant`} className="underline underline-offset-4">
          Add your own Claude, OpenAI or other key
        </Link>
      </p>
    );
  }
  const name = provider ? assistantProviderNames[provider] : "Choose a provider";
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open && provider) {
          setModels(null);
          void loadModels(provider).then(setModels);
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="mb-2 flex max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-status-completed" aria-hidden />
          <span className="truncate">
            {name} · {model ?? "choose a model"}
          </span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {keys.length > 1 && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Provider</DropdownMenuLabel>
            {keys.map((k) => (
              <DropdownMenuItem
                key={k.provider}
                onSelect={() => void setProvider(k.provider)}
                className="gap-2"
              >
                <span className="flex-1">{assistantProviderNames[k.provider]}</span>
                {k.provider === provider && <Check className="size-3.5" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel className="text-xs text-muted-foreground">Model</DropdownMenuLabel>
        <div className="max-h-64 overflow-y-auto">
          {models === null ? (
            <div className="flex justify-center py-3">
              <Spinner />
            </div>
          ) : models.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              Couldn&apos;t list models.{" "}
              <Link href={`/${slug}/settings/assistant`} className="underline underline-offset-4">
                Set one in settings
              </Link>
            </p>
          ) : (
            models.map((m) => (
              <DropdownMenuItem key={m} onSelect={() => void setModel(m)} className="gap-2">
                <span className="flex-1 truncate font-mono text-xs">{m}</span>
                {m === model && <Check className="size-3.5" />}
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const SUGGESTIONS = ["Summarise this page", "What's due this week?", "Draft tasks from my notes"];

function Welcome({ slug, onPick }: { slug: string; onPick: (text: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-2 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Sparkles className="size-5 text-muted-foreground" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-medium">Ask your assistant</p>
        <p className="text-sm text-muted-foreground">
          It uses your own AI API key and works in the workspace with your permissions. It sees the page you
          have open.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-1.5">
        {SUGGESTIONS.map((s) => (
          <Button key={s} variant="outline" size="xs" onClick={() => onPick(s)}>
            {s}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>J</Kbd>
        </KbdGroup>{" "}
        to open or close ·{" "}
        <Link href={`/${slug}/settings/assistant`} className="underline underline-offset-4">
          Settings
        </Link>
      </p>
    </div>
  );
}
