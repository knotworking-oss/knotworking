"use client";

import {
  applyAssistantEvent,
  ASSISTANT_STREAM_EVENT,
  type AssistantContext,
  type AssistantMessageStatus,
  type AssistantPart,
  type AssistantProvider,
  type AssistantStreamMessage,
} from "@knotworking/core";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, browserApi, errorMessage, unwrap, unwrapEmpty } from "./auth-client";

/**
 * The assistant sidebar's state (docs/assistant.md): whether it is open, the person's
 * conversations, the open one's messages, which provider keys they have and the provider and model
 * the open chat uses. Replies stream in over `…/assistant/stream` and are folded with the same
 * `applyAssistantEvent` the API stores.
 */

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  text: string | null;
  parts: AssistantPart[];
  status: AssistantMessageStatus;
  error: string | null;
  createdAt: string;
}
export interface AssistantConversation {
  id: string;
  title: string;
  provider: AssistantProvider;
  model: string | null;
  updatedAt: string;
}
/** A saved provider key as the API shows it: never the key itself. */
export interface AssistantKeyInfo {
  provider: AssistantProvider;
  last4: string;
  model: string | null;
}
export interface AssistantPrefs {
  scope: "read" | "write";
  defaultProvider: AssistantProvider | null;
}

interface AssistantStore {
  enabled: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  conversations: AssistantConversation[];
  conversationId: string | null;
  messages: AssistantMessage[];
  loading: boolean;
  /** The person's saved provider keys; `null` until the first status arrives. */
  keys: AssistantKeyInfo[] | null;
  /** The provider the open chat uses (a new chat: the person's default, or the one they picked). */
  provider: AssistantProvider | null;
  /** The model the open chat uses: its own, else the provider's saved one; null when none is chosen. */
  model: string | null;
  setProvider: (provider: AssistantProvider) => Promise<void>;
  setModel: (model: string) => Promise<void>;
  /** Model ids the provider's key can use (a live call, cached), for the picker. */
  loadModels: (provider: AssistantProvider) => Promise<string[]>;
  /** Whether a reply is streaming in the open conversation. */
  busy: boolean;
  /** Last send error (no key, no model, provider refused…), shown above the composer. */
  error: string | null;
  send: (text: string) => Promise<boolean>;
  stop: () => Promise<void>;
  newChat: () => void;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => Promise<void>;
}

const Ctx = createContext<AssistantStore | null>(null);

export function useAssistant() {
  const store = useContext(Ctx);
  if (!store) throw new Error("useAssistant must be used inside <AssistantProvider>");
  return store;
}

/** Like `useAssistant`, but null outside a provider (or when the module is off). */
export function useOptionalAssistant() {
  return useContext(Ctx);
}

const OPEN_KEY = "knotworking.assistant.open";
const readOpen = () => {
  try {
    return window.localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
};

/** What the person is looking at, sent with each prompt. */
export function currentContext(pathname: string): AssistantContext {
  const title = typeof document === "undefined" ? "" : document.title.replace(/\s*[·|–-]\s*Knotworking$/, "");
  return { path: pathname.slice(0, 500), ...(title ? { title: title.slice(0, 300) } : {}) };
}

/** Folds a stream message into the open conversation's messages. Exported for tests. */
export function applyStreamMessage(
  messages: AssistantMessage[],
  message: AssistantStreamMessage,
): AssistantMessage[] {
  const index = messages.findIndex((m) => m.id === message.messageId);
  if (index < 0) return messages;
  const current = messages[index]!;
  let next: AssistantMessage;
  if (message.type === "event") {
    const reply = applyAssistantEvent(
      { parts: current.parts, status: current.status, ...(current.error ? { error: current.error } : {}) },
      message.event,
    );
    next = { ...current, parts: reply.parts, status: reply.status, error: reply.error ?? null };
  } else {
    if (current.status !== "running") return messages;
    next = {
      ...current,
      status: message.status,
      error: message.error ?? null,
      parts: current.parts.map((p) =>
        p.type === "text"
          ? { type: "text", text: p.text }
          : p.status === "running"
            ? { ...p, status: "error" }
            : p,
      ),
    };
  }
  const copy = [...messages];
  copy[index] = next;
  return copy;
}

export function AssistantProvider({
  slug,
  enabled,
  children,
}: {
  slug: string;
  enabled: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpenState] = useState(false);
  const [conversations, setConversations] = useState<AssistantConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [keys, setKeys] = useState<AssistantKeyInfo[] | null>(null);
  const [prefs, setPrefs] = useState<AssistantPrefs | null>(null);
  // A new chat's choice, before the conversation exists.
  const [draft, setDraft] = useState<{ provider: AssistantProvider | null; model: string | null }>({
    provider: null,
    model: null,
  });
  const modelsCache = useRef(new Map<AssistantProvider, string[]>());
  const [error, setError] = useState<string | null>(null);
  const conversationRef = useRef<string | null>(null);
  conversationRef.current = conversationId;
  const ws = useCallback(() => browserApi().v1.workspaces[":slug"].assistant, []);

  useEffect(() => {
    if (enabled && readOpen()) setOpenState(true);
  }, [enabled]);
  const setOpen = useCallback((value: boolean) => {
    setOpenState(value);
    try {
      window.localStorage.setItem(OPEN_KEY, value ? "1" : "0");
    } catch {
      // private mode: not remembered
    }
  }, []);
  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);

  // ⌘J / Ctrl+J opens and closes the assistant anywhere in the workspace.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "j" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setOpen(!open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, open, setOpen]);

  const refreshConversations = useCallback(async () => {
    try {
      const { conversations } = await unwrap(ws().conversations.$get({ param: { slug } }));
      setConversations(conversations);
    } catch {
      // shown as an empty list; sending reports real errors
    }
  }, [slug, ws]);

  // Which keys the person has and their defaults: fetched whenever the panel opens, so a key added
  // on the settings page shows up without a reload.
  const refreshStatus = useCallback(async () => {
    try {
      const res = await unwrap(ws().status.$get({ param: { slug } }));
      setKeys(res.keys);
      setPrefs(res.settings);
      // A replaced or removed key means the cached model lists may be wrong.
      modelsCache.current.clear();
    } catch {
      // the composer reports real errors when sending
    }
  }, [slug, ws]);

  // The panel stays open beside every page, so a key added on the settings page must show up
  // without reopening it: refresh on navigation and when the tab regains focus.
  useEffect(() => {
    if (!enabled || !open) return;
    const onFocus = () => void refreshStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, open, refreshStatus]);

  // Load the list once the panel is first opened.
  const loaded = useRef(false);
  useEffect(() => {
    if (!enabled || !open) return;
    void refreshStatus();
    if (loaded.current) return;
    loaded.current = true;
    void refreshConversations();
  }, [enabled, open, pathname, refreshConversations, refreshStatus]);

  /**
   * Refetches the open conversation without clearing it: after the stream reconnects (events in
   * the gap are lost) and when an event names a reply this tab doesn't have yet.
   */
  const reload = useCallback(async () => {
    const id = conversationRef.current;
    if (!id) return;
    try {
      const res = await unwrap(ws().conversations[":id"].$get({ param: { slug, id } }));
      if (conversationRef.current === id) setMessages(res.messages as AssistantMessage[]);
    } catch {
      // keep what is shown; the next action reports real errors
    }
  }, [slug, ws]);
  const messagesRef = useRef<AssistantMessage[]>([]);
  messagesRef.current = messages;

  // Live: reply events, while the panel is open.
  useEffect(() => {
    if (!enabled || !open || typeof EventSource === "undefined") return;
    const source = new EventSource(`/api/v1/workspaces/${encodeURIComponent(slug)}/assistant/stream`);
    let opened = false;
    source.addEventListener("open", () => {
      // A reconnect: anything sent while the stream was down (a reply ending) was missed.
      if (opened) void reload();
      opened = true;
    });
    source.addEventListener(ASSISTANT_STREAM_EVENT, (e) => {
      const message = JSON.parse((e as MessageEvent<string>).data) as AssistantStreamMessage;
      if (message.conversationId === conversationRef.current) {
        if (messagesRef.current.some((m) => m.id === message.messageId)) {
          setMessages((current) => applyStreamMessage(current, message));
        } else void reload(); // the reply's events beat the POST's response, or this tab is behind
      }
      if (message.type === "ended") void refreshConversations();
    });
    return () => source.close();
  }, [enabled, open, slug, refreshConversations, reload]);

  const selectConversation = useCallback(
    (id: string) => {
      setConversationId(id);
      setError(null);
      setLoading(true);
      setMessages([]);
      void (async () => {
        try {
          const res = await unwrap(ws().conversations[":id"].$get({ param: { slug, id } }));
          if (conversationRef.current === id) setMessages(res.messages as AssistantMessage[]);
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setLoading(false);
        }
      })();
    },
    [slug, ws],
  );

  const newChat = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    setError(null);
    setDraft({ provider: null, model: null });
  }, []);

  const send = useCallback(
    async (text: string) => {
      setError(null);
      try {
        let id = conversationRef.current;
        if (!id) {
          const { conversation } = await unwrap(
            ws().conversations.$post({
              param: { slug },
              json: {
                ...(draft.provider ? { provider: draft.provider } : {}),
                ...(draft.model ? { model: draft.model } : {}),
              },
            }),
          );
          id = conversation.id;
          setConversationId(id);
          conversationRef.current = id;
        }
        const res = await unwrap(
          ws().conversations[":id"].messages.$post({
            param: { slug, id },
            json: { text, context: currentContext(pathname) },
          }),
        );
        // A reload triggered by early stream events may already have added them.
        setMessages((current) => [
          ...current,
          ...[res.prompt as AssistantMessage, res.reply as AssistantMessage].filter(
            (m) => !current.some((c) => c.id === m.id),
          ),
        ]);
        void refreshConversations();
        return true;
      } catch (err) {
        setError(errorMessage(err));
        if (err instanceof ApiError && err.code === "not_found") newChat();
        return false;
      }
    },
    [slug, ws, pathname, refreshConversations, newChat, draft],
  );

  const stop = useCallback(async () => {
    const id = conversationRef.current;
    if (!id) return;
    try {
      const { cancelled } = await unwrap(ws().conversations[":id"].cancel.$post({ param: { slug, id } }));
      // Nothing was running on the server: this tab missed the end, so catch up.
      if (!cancelled) await reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [slug, ws, reload]);

  const deleteConversation = useCallback(
    async (id: string) => {
      try {
        await unwrapEmpty(ws().conversations[":id"].$delete({ param: { slug, id } }));
        setConversations((list) => list.filter((c) => c.id !== id));
        if (conversationRef.current === id) newChat();
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [slug, ws, newChat],
  );

  const current = conversations.find((c) => c.id === conversationId);
  const provider: AssistantProvider | null =
    current?.provider ?? draft.provider ?? prefs?.defaultProvider ?? keys?.[0]?.provider ?? null;
  const savedModel = keys?.find((k) => k.provider === provider)?.model ?? null;
  const model = current ? (current.model ?? savedModel) : (draft.model ?? savedModel);

  /** Changes the open chat (or the next new chat) to another provider; its model is chosen again. */
  const setProvider = useCallback(
    async (next: AssistantProvider) => {
      const id = conversationRef.current;
      if (!id) return setDraft({ provider: next, model: null });
      try {
        await unwrap(ws().conversations[":id"].$patch({ param: { slug, id }, json: { provider: next } }));
        setConversations((list) =>
          list.map((c) => (c.id === id ? { ...c, provider: next, model: null } : c)),
        );
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [slug, ws],
  );
  const setModel = useCallback(
    async (next: string) => {
      const id = conversationRef.current;
      if (!id) return setDraft((d) => ({ ...d, model: next }));
      try {
        await unwrap(ws().conversations[":id"].$patch({ param: { slug, id }, json: { model: next } }));
        setConversations((list) => list.map((c) => (c.id === id ? { ...c, model: next } : c)));
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [slug, ws],
  );
  const loadModels = useCallback(async (p: AssistantProvider) => {
    const cached = modelsCache.current.get(p);
    if (cached) return cached;
    try {
      const res = await unwrap(
        browserApi().v1.me.assistant.keys[":provider"].models.$get({ param: { provider: p } }),
      );
      modelsCache.current.set(p, res.models);
      return res.models;
    } catch {
      return [];
    }
  }, []);

  const busy = messages.some((m) => m.status === "running");
  const value = useMemo<AssistantStore>(
    () => ({
      enabled,
      open: enabled && open,
      setOpen,
      toggle,
      conversations,
      conversationId,
      messages,
      loading,
      keys,
      provider,
      model,
      setProvider,
      setModel,
      loadModels,
      busy,
      error,
      send,
      stop,
      newChat,
      selectConversation,
      deleteConversation,
    }),
    [
      enabled,
      open,
      setOpen,
      toggle,
      conversations,
      conversationId,
      messages,
      loading,
      keys,
      provider,
      model,
      setProvider,
      setModel,
      loadModels,
      busy,
      error,
      send,
      stop,
      newChat,
      selectConversation,
      deleteConversation,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
