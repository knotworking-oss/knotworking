"use client";

import { useWorkspaceTimeZone } from "@/lib/workspace-time";
import { modules, type ModuleId, type PersonOnlyKind } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ResultBadge, TokenActionRow } from "@/components/token-action-row";
import type { PersonOnlyItem, TokenActionItem, TokenActionLog, TokenActions } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatDateTime } from "@/lib/format";

const kindTitles: Record<PersonOnlyKind, string> = {
  sign_off: "Sign-offs and approvals",
  attestation: "Attestations",
  correction: "Corrections of the record",
  safety: "Safety",
};

/** Groups items by module, keeping first-seen order. */
function byModule<T extends { module: ModuleId }>(items: readonly T[]) {
  const groups = new Map<ModuleId, T[]>();
  for (const item of items) groups.set(item.module, [...(groups.get(item.module) ?? []), item]);
  return [...groups];
}

/** Settings → API access: which person-only actions API tokens may do, who may not, and an audit log. */
export function ApiAccessManager({
  slug,
  data,
  log,
  pageSize,
}: {
  slug: string;
  data: TokenActions;
  log: TokenActionLog | null;
  pageSize: number;
}) {
  const timeZone = useWorkspaceTimeZone();
  const [actions, setActions] = useState<TokenActionItem[]>(data.actions);
  const [pending, setPending] = useState<Set<string>>(new Set());
  useEffect(() => setActions(data.actions), [data.actions]);

  async function toggle(id: string, enabled: boolean) {
    // Roll back only this action on failure: other switches may be saving at the same time.
    const previous = actions.find((a) => a.id === id);
    setActions((list) => list.map((a) => (a.id === id ? { ...a, enabled } : a)));
    setPending((p) => new Set(p).add(id));
    try {
      const saved = await unwrap(
        browserApi().v1.workspaces[":slug"]["token-actions"][":action"].$put({
          param: { slug, action: id },
          json: { enabled },
        }),
      );
      setActions((list) => list.map((a) => (a.id === id ? { ...a, ...saved } : a)));
    } catch (err) {
      if (previous) setActions((list) => list.map((a) => (a.id === id ? previous : a)));
      toast.error(errorMessage(err));
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(id);
        return next;
      });
    }
  }

  const kinds = Object.keys(kindTitles) as PersonOnlyKind[];
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-6 py-8">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">API access</h2>
        {!data.canManage && (
          <p className="text-sm text-muted-foreground">Only owners and admins can change these.</p>
        )}
      </div>

      {byModule(actions).map(([moduleId, items]) => (
        <section key={moduleId} className="flex flex-col gap-3">
          <h3 className="font-medium">{modules[moduleId].name}</h3>
          <Card className="divide-y py-0">
            {items.map((action) => (
              <TokenActionRow
                key={action.id}
                action={action}
                canManage={data.canManage}
                timeZone={timeZone}
                pending={pending.has(action.id)}
                onToggle={(enabled) => void toggle(action.id, enabled)}
              />
            ))}
          </Card>
        </section>
      ))}
      {actions.length === 0 && (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          None of the modules you can read has actions that can be opened to tokens.
        </p>
      )}

      {data.personOnly.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="font-medium">Always a person</h3>
          {kinds.map((kind) => {
            const items = data.personOnly.filter((p) => p.kind === kind);
            if (items.length === 0) return null;
            return <PersonOnlyGroup key={kind} kind={kind} items={items} />;
          })}
        </section>
      )}

      {log && <AuditLog slug={slug} initial={log} pageSize={pageSize} />}
    </div>
  );
}

function PersonOnlyGroup({ kind, items }: { kind: PersonOnlyKind; items: PersonOnlyItem[] }) {
  return (
    <Card className="gap-0 py-0">
      <div className="border-b px-4 py-3">
        <h4 className="text-sm font-medium">{kindTitles[kind]}</h4>
        <p className="text-xs text-muted-foreground">{items[0]?.reason}</p>
      </div>
      <ul className="divide-y text-sm">
        {items.map((item) => (
          <li
            key={`${item.module}:${item.label}`}
            className="flex items-baseline justify-between gap-4 px-4 py-2"
          >
            <span>{item.label}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{modules[item.module].name}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AuditLog({ slug, initial, pageSize }: { slug: string; initial: TokenActionLog; pageSize: number }) {
  const timeZone = useWorkspaceTimeZone();
  const [offset, setOffset] = useState(0);
  const [log, setLog] = useState(initial);
  const [loading, setLoading] = useState(false);
  // A refresh (e.g. after an API access toggle) brings a fresh first page: show it from the top.
  useEffect(() => {
    setLog(initial);
    setOffset(0);
  }, [initial]);

  async function go(next: number) {
    setLoading(true);
    try {
      const page = await unwrap(
        browserApi().v1.workspaces[":slug"]["token-actions"].log.$get({
          param: { slug },
          query: { limit: String(pageSize), offset: String(next) },
        }),
      );
      setLog(page);
      setOffset(next);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  const from = log.total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + log.entries.length, log.total);
  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-medium">Audit log</h3>
      {log.entries.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No token has used these actions yet.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Time</TableHead>
                <TableHead>Token</TableHead>
                <TableHead className="hidden md:table-cell">Person</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="pr-4 text-right">Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log.entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="pl-4 text-muted-foreground max-md:w-24 max-md:whitespace-normal md:whitespace-nowrap">
                    {formatDateTime(e.createdAt, timeZone)}
                  </TableCell>
                  <TableCell>
                    {e.tokenName}
                    <span className="block text-xs text-muted-foreground md:hidden">{e.userName}</span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {e.userName ?? <span className="text-muted-foreground">Deleted user</span>}
                  </TableCell>
                  <TableCell>
                    {e.label ?? e.action}
                    {e.note && <span className="block text-xs text-muted-foreground">{e.note}</span>}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <ResultBadge status={e.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {log.total > pageSize && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {from}–{to} of {log.total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={loading || offset === 0}
              onClick={() => void go(Math.max(0, offset - pageSize))}
            >
              <ChevronLeft /> Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || offset + pageSize >= log.total}
              onClick={() => void go(offset + pageSize)}
            >
              Older <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
