"use client";

import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Label } from "@knotworking/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@knotworking/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import { Check, Copy, KeyRound, Pencil, Plus, TriangleAlert, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { tokenActionList, type ModuleId, type TokenActionId } from "@knotworking/core";
import type { ApiToken } from "@/lib/api";
import {
  claudeCodeCommand,
  DEFAULT_TOKEN_EXPIRY_DAYS,
  expiryText,
  isTokenExpired,
  ORDER_LIMIT_HELP,
  parseOrderLimit,
  stdioConfig,
  TOKEN_EXPIRY_OPTIONS,
  tokenErrorMessage,
  tokenPrefixLabel,
  type TokenScope,
} from "@/lib/api-tokens";
import { browserApi, unwrap, unwrapEmpty } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { relativeTime } from "@/lib/relative-time";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

/** A freshly created token. Lives in client state only, until the user dismisses it. */
interface Revealed {
  token: string;
  name: string;
  scope: TokenScope;
}

export function ApiTokensManager({ slug, tokens }: { slug: string; tokens: ApiToken[] }) {
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [editing, setEditing] = useState<ApiToken | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const sorted = [...tokens].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // The plaintext exists only in this page's memory; warn before a reload throws it away.
  useEffect(() => {
    if (!revealed) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [revealed]);

  return (
    <div className="workspace-content flex flex-col gap-6 py-8">
      <h2 className="text-xl font-semibold tracking-tight">API tokens</h2>

      {revealed && (
        <TokenReveal
          slug={slug}
          revealed={revealed}
          onDismiss={() => {
            setRevealed(null);
            requestAnimationFrame(() => nameRef.current?.focus());
          }}
        />
      )}

      <CreateTokenForm nameRef={nameRef} locked={revealed !== null} onCreated={setRevealed} />

      <section aria-labelledby="your-tokens" className="flex flex-col gap-3">
        <h3 id="your-tokens" className="text-sm font-medium">
          Your tokens
        </h3>
        {sorted.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            No tokens yet. Create one above to connect an agent.
          </p>
        ) : (
          <Card className="gap-0 py-0">
            <ul>
              {sorted.map((t) => (
                <TokenRow key={t.id} token={t} onRevoke={() => setRevoking(t)} onEdit={() => setEditing(t)} />
              ))}
            </ul>
          </Card>
        )}
      </section>

      <RevokeDialog token={revoking} onOpenChange={(o) => !o && setRevoking(null)} />
      <EditActionsDialog token={editing} onOpenChange={(o) => !o && setEditing(null)} />
    </div>
  );
}

function CreateTokenForm({
  nameRef,
  locked,
  onCreated,
}: {
  nameRef: React.RefObject<HTMLInputElement | null>;
  locked: boolean;
  onCreated: (revealed: Revealed) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<TokenScope>("read");
  const [days, setDays] = useState(String(DEFAULT_TOKEN_EXPIRY_DAYS));
  const [pending, setPending] = useState(false);
  // Modules the token may use. `null` = everything you can use (including modules added later).
  const usable = useWorkspace().modules.filter((m) => m.access !== "none");
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const isAllowed = (id: string) => allowed === null || allowed.includes(id);
  // Person-only actions the token may use (none by default); an owner or admin must also allow each.
  const [actions, setActions] = useState<TokenActionId[]>([]);
  const [orderLimit, setOrderLimit] = useState("");
  const toggleModule = (id: string, on: boolean) => {
    const current = allowed ?? usable.map((m) => m.id);
    const next = on ? [...current, id] : current.filter((m) => m !== id);
    setAllowed(usable.every((m) => next.includes(m.id)) ? null : next);
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const limit = parseOrderLimit(orderLimit);
    if (actions.includes("purchasing.send") && Number.isNaN(limit)) {
      toast.error(ORDER_LIMIT_HELP);
      return;
    }
    setPending(true);
    try {
      const created = await unwrap(
        browserApi().v1.me["api-tokens"].$post({
          json: {
            name: name.trim(),
            scope,
            expiresInDays: Number(days),
            modules: allowed as ModuleId[] | null,
            tokenActions: actions,
            ...(actions.includes("purchasing.send") ? { maxOrderValue: limit } : {}),
          },
        }),
      );
      onCreated({ token: created.token, name: created.apiToken.name, scope: created.apiToken.scope });
      setName("");
      setScope("read");
      setAllowed(null);
      setActions([]);
      setOrderLimit("");
      setDays(String(DEFAULT_TOKEN_EXPIRY_DAYS));
      router.refresh();
    } catch (err) {
      toast.error(tokenErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a token</CardTitle>
        <CardDescription>
          {locked
            ? "Dismiss the new token above once you've copied it to create another."
            : "The token is shown once, right after you create it."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <fieldset disabled={locked || pending} className="contents">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="token-name">Name</FieldLabel>
                <Input
                  id="token-name"
                  ref={nameRef}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Claude Code on my laptop"
                  required
                  maxLength={80}
                  autoComplete="off"
                />
                <FieldDescription>Helps you recognize it later when you revoke it.</FieldDescription>
              </Field>

              <Field>
                <FieldLabel id="token-scope-label">Access</FieldLabel>
                <RadioGroup
                  aria-labelledby="token-scope-label"
                  value={scope}
                  onValueChange={(v) => setScope(v as TokenScope)}
                >
                  <div className="flex items-start gap-3">
                    <RadioGroupItem value="read" id="scope-read" className="mt-0.5" />
                    <div className="grid gap-0.5">
                      <Label htmlFor="scope-read">Read only</Label>
                      <p className="text-xs text-muted-foreground">
                        Can look up tasks, projects and documents. Every change is refused.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <RadioGroupItem value="write" id="scope-write" className="mt-0.5" />
                    <div className="grid gap-0.5">
                      <Label htmlFor="scope-write">Read and write</Label>
                      <p className="text-xs text-muted-foreground">
                        Can also create and edit tasks, comments and documents as you.
                      </p>
                    </div>
                  </div>
                </RadioGroup>
              </Field>

              {usable.length > 0 && (
                <Field>
                  <FieldLabel id="token-modules-label">Modules</FieldLabel>
                  <div
                    role="group"
                    aria-labelledby="token-modules-label"
                    className="flex flex-wrap gap-x-5 gap-y-2"
                  >
                    {usable.map((m) => (
                      <div key={m.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`token-module-${m.id}`}
                          checked={isAllowed(m.id)}
                          onCheckedChange={(on) => toggleModule(m.id, on === true)}
                        />
                        <Label htmlFor={`token-module-${m.id}`}>{m.name}</Label>
                      </div>
                    ))}
                  </div>
                  <FieldDescription>
                    Untick what the agent doesn’t need. The token can never do more than you can.
                  </FieldDescription>
                </Field>
              )}

              {scope === "write" && (
                <TokenActionsField
                  idPrefix="new"
                  value={actions}
                  onChange={setActions}
                  orderLimit={orderLimit}
                  onOrderLimitChange={setOrderLimit}
                />
              )}

              {scope === "write" && (
                <Alert>
                  <TriangleAlert />
                  <AlertTitle>Write tokens can change your workspace</AlertTitle>
                  <AlertDescription>
                    An agent holding this token can edit anything you can, and may be tricked by text in tasks
                    or documents. Prefer a read-only token unless the agent really has to make changes.
                  </AlertDescription>
                </Alert>
              )}

              <Field>
                <FieldLabel htmlFor="token-expiry">Expires after</FieldLabel>
                <Select value={days} onValueChange={setDays}>
                  <SelectTrigger id="token-expiry" className="w-full sm:w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TOKEN_EXPIRY_OPTIONS.map((o) => (
                      <SelectItem key={o.days} value={String(o.days)}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <div>
                <Button type="submit" disabled={locked || pending || !name.trim()}>
                  {pending ? <Spinner /> : <Plus />} Create token
                </Button>
              </div>
            </FieldGroup>
          </fieldset>
        </form>
      </CardContent>
    </Card>
  );
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      toast.error("Couldn't copy automatically. Select the text and copy it manually.");
    }
  }
  return { copied, copy };
}

function CopyButton({ id, text, label }: { id: string; text: string; label: string }) {
  const { copied, copy } = useCopy();
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => copy(id, text)}>
      {copied === id ? <Check /> : <Copy />}
      <span aria-live="polite">{copied === id ? "Copied" : label}</span>
    </Button>
  );
}

function TokenReveal({
  slug,
  revealed,
  onDismiss,
}: {
  slug: string;
  revealed: Revealed;
  onDismiss: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Origin is read here (client only, after a user action), never during server rendering.
  const origin = window.location.origin;
  const command = claudeCodeCommand(origin, revealed.token);
  const stdio = stdioConfig(origin, revealed.token, { workspaceSlug: slug });

  useEffect(() => {
    headingRef.current?.focus();
    headingRef.current?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <Card role="region" aria-labelledby="token-reveal-title" className="ring-2 ring-primary/40">
      <CardHeader>
        <CardTitle
          id="token-reveal-title"
          ref={headingRef}
          tabIndex={-1}
          className="flex items-center gap-2 outline-none"
        >
          <KeyRound className="size-4" /> Your new token
        </CardTitle>
        <CardDescription>
          {revealed.name} <Badge variant="secondary">{revealed.scope}</Badge>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Copy it now. You won&apos;t see this token again.</AlertTitle>
          <AlertDescription>
            Only a fingerprint is stored. If you lose it, revoke it and create a new one. Treat it like a
            password.
          </AlertDescription>
        </Alert>

        <div className="flex flex-col gap-2">
          <Label htmlFor="new-token">Token</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="new-token"
              readOnly
              value={revealed.token}
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            <CopyButton id="token" text={revealed.token} label="Copy token" />
          </div>
        </div>

        <Tabs defaultValue="claude-code">
          <TabsList>
            <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
            <TabsTrigger value="stdio">Claude Desktop (stdio)</TabsTrigger>
          </TabsList>
          <TabsContent value="claude-code" className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Run this in a terminal. It connects to the MCP server at <code>{origin}/mcp</code>.
            </p>
            <Snippet label="Claude Code command" text={command} />
            <div>
              <CopyButton id="command" text={command} label="Copy command" />
            </div>
          </TabsContent>
          <TabsContent value="stdio" className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Add this to <code>claude_desktop_config.json</code> (or any client that launches a local
              command), and replace the path with your build of <code>apps/mcp/dist/stdio.js</code>.
            </p>
            <Snippet label="stdio client configuration" text={stdio} />
            <div>
              <CopyButton id="stdio" text={stdio} label="Copy config" />
            </div>
          </TabsContent>
        </Tabs>
        <p className="text-xs text-muted-foreground">
          The MCP server is reached at <code>/mcp</code> on this address when you run Knotworking with Docker
          Compose. In local development it listens on <code>http://localhost:4100/mcp</code> instead. See
          docs/mcp.md.
        </p>
      </CardContent>
      <div className="flex justify-end px-4">
        <Button type="button" onClick={onDismiss}>
          <Check /> I&apos;ve saved it, dismiss
        </Button>
      </div>
    </Card>
  );
}

function Snippet({ label, text }: { label: string; text: string }) {
  return (
    <pre
      tabIndex={0}
      aria-label={label}
      className="overflow-x-auto rounded-md border bg-muted p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
    >
      {text}
    </pre>
  );
}

/**
 * Which person-only actions (send a purchase order, record waste, …) a token may use, and the
 * largest order it may send. They only work where an owner or admin has also allowed the action
 * under API access; the list shows the actions of modules the person can use themselves.
 */
function TokenActionsField({
  idPrefix,
  value,
  onChange,
  orderLimit,
  onOrderLimitChange,
}: {
  idPrefix: string;
  value: TokenActionId[];
  onChange: (next: TokenActionId[]) => void;
  orderLimit: string;
  onOrderLimitChange: (next: string) => void;
}) {
  const { can } = useWorkspace();
  const available = tokenActionList.filter((a) => can(a.module, a.level));
  if (available.length === 0) return null;
  const toggle = (id: TokenActionId, on: boolean) =>
    onChange(on ? [...value, id] : value.filter((v) => v !== id));
  return (
    <Field>
      <FieldLabel id={`${idPrefix}-actions-label`}>Person-only actions</FieldLabel>
      <div role="group" aria-labelledby={`${idPrefix}-actions-label`} className="flex flex-col gap-2">
        {available.map((a) => (
          <div key={a.id} className="flex items-start gap-2">
            <Checkbox
              id={`${idPrefix}-action-${a.id}`}
              className="mt-0.5"
              checked={value.includes(a.id)}
              onCheckedChange={(on) => toggle(a.id, on === true)}
            />
            <div className="grid gap-0.5">
              <Label htmlFor={`${idPrefix}-action-${a.id}`}>{a.label}</Label>
              <p className="text-xs text-muted-foreground">{a.description}</p>
            </div>
          </div>
        ))}
      </div>
      {value.includes("purchasing.send") && (
        <div className="mt-2 flex flex-col gap-1">
          <Label htmlFor={`${idPrefix}-order-limit`}>Largest purchase order it may send</Label>
          <Input
            id={`${idPrefix}-order-limit`}
            inputMode="decimal"
            value={orderLimit}
            onChange={(e) => onOrderLimitChange(e.target.value)}
            placeholder="No limit"
            className="w-full sm:w-48"
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Orders worth more, or with an unpriced line, are refused and a person has to send them.
          </p>
        </div>
      )}
      <FieldDescription>
        None by default. Each action also has to be allowed for the workspace by an owner or admin under API
        access, and the token can never do more than you can.
      </FieldDescription>
    </Field>
  );
}

function EditActionsDialog({
  token,
  onOpenChange,
}: {
  token: ApiToken | null;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [actions, setActions] = useState<TokenActionId[]>([]);
  const [orderLimit, setOrderLimit] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!token) return;
    // A token made before allowlists existed is unrestricted: start from every action.
    setActions((token.tokenActions as TokenActionId[] | null) ?? tokenActionList.map((a) => a.id));
    setOrderLimit(token.maxOrderValue === null ? "" : String(token.maxOrderValue));
  }, [token]);

  async function save() {
    if (!token) return;
    const limit = actions.includes("purchasing.send") ? parseOrderLimit(orderLimit) : null;
    if (Number.isNaN(limit)) {
      toast.error(ORDER_LIMIT_HELP);
      return;
    }
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.me["api-tokens"][":id"].$patch({
          param: { id: token.id },
          json: { tokenActions: actions, maxOrderValue: limit },
        }),
      );
      toast.success(`${token.name} updated`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      toast.error(tokenErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={token !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Person-only actions for {token?.name}</DialogTitle>
          <DialogDescription>
            Choose what this token may do that normally needs a person. Changes apply at once.
            {token?.tokenActions === null &&
              " This token was made before the list existed, so it can use every action the workspace allows until you save."}
          </DialogDescription>
        </DialogHeader>
        <TokenActionsField
          idPrefix="edit"
          value={actions}
          onChange={setActions}
          orderLimit={orderLimit}
          onOrderLimitChange={setOrderLimit}
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button disabled={pending} onClick={save}>
            {pending && <Spinner />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TokenRow({
  token,
  onRevoke,
  onEdit,
}: {
  token: ApiToken;
  onRevoke: () => void;
  onEdit: () => void;
}) {
  const timeZone = useWorkspaceTimeZone();
  const expired = isTokenExpired(token);
  return (
    <li className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{token.name}</span>
          <Badge variant={token.scope === "write" ? "default" : "secondary"}>{token.scope}</Badge>
          {token.modules && (
            <Badge variant="outline">{token.modules.length ? token.modules.join(", ") : "no modules"}</Badge>
          )}
          {expired && <Badge variant="destructive">Expired</Badge>}
          {token.scope === "write" && (
            <Badge variant="outline">
              {token.tokenActions === null
                ? "all allowed person-only actions"
                : token.tokenActions.length === 0
                  ? "no person-only actions"
                  : `${token.tokenActions.length} person-only action${token.tokenActions.length === 1 ? "" : "s"}`}
              {token.maxOrderValue !== null && `, orders up to ${token.maxOrderValue.toFixed(2)}`}
            </Badge>
          )}
        </div>
        <code className="w-fit text-xs text-muted-foreground">{tokenPrefixLabel(token.prefix)}</code>
        <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span>Created {relativeTime(token.createdAt)}</span>
          <span>{token.lastUsedAt ? `Last used ${relativeTime(token.lastUsedAt)}` : "Never used"}</span>
          <span title={token.expiresAt ? formatLongDate(token.expiresAt, timeZone) : undefined}>
            {expiryText(token, relativeTime)}
          </span>
        </p>
      </div>
      {token.scope === "write" && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-muted-foreground sm:self-center"
          aria-label={`Edit person-only actions of ${token.name}`}
          onClick={onEdit}
        >
          <Pencil /> Actions
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="self-start text-muted-foreground hover:text-destructive sm:self-center"
        aria-label={`Revoke ${token.name}`}
        onClick={onRevoke}
      >
        <Trash2 /> Revoke
      </Button>
    </li>
  );
}

function RevokeDialog({
  token,
  onOpenChange,
}: {
  token: ApiToken | null;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function revoke() {
    if (!token) return;
    setPending(true);
    try {
      await unwrapEmpty(browserApi().v1.me["api-tokens"][":id"].$delete({ param: { id: token.id } }));
      toast.success(`${token.name} revoked`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      toast.error(tokenErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={token !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke {token?.name}?</DialogTitle>
          <DialogDescription>
            Anything using this token stops working right away, and open event streams end shortly after. This
            can&apos;t be undone. You can create a new token any time.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="destructive" disabled={pending} onClick={revoke}>
            {pending && <Spinner />} Revoke token
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
