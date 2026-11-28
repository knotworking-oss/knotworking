"use client";

import {
  biDataWidgetCount,
  biDatasets,
  biEmptySpec,
  biFitSpecToCatalogue,
  biRestrictCatalogue,
  biScopeModule,
  biTemplates,
  modules as moduleManifest,
  type BiTemplate,
  type ModuleId,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@knotworking/ui/components/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@knotworking/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Textarea } from "@knotworking/ui/components/textarea";
import { BookCopy, BookOpen, FileJson, LayoutDashboard, LayoutTemplate, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { BiCatalogueAnswer, DashboardSummary } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceCurrency } from "@/lib/workspace-time";
import { omittedNotice } from "@/lib/bi-format";

/** Modules with data in the catalogue: the ones a dashboard can belong to. */
const MODULES_WITH_DATA = new Set<ModuleId>(biDatasets.flatMap((d) => (d.virtual ? [] : [d.module])));
const ALL = "__all";

/** Dashboards the viewer may open: published ones for their audience, and their own drafts. */
export function DashboardList({
  slug,
  scope,
  dashboards,
  templates,
  catalogue,
  modules,
  canCreate,
}: {
  slug: string;
  /** `workspace` or `module:<id>` when the list is narrowed to one. */
  scope?: string;
  dashboards: DashboardSummary[];
  /** Dashboards saved as templates that the viewer may open. */
  templates: DashboardSummary[];
  /** What the viewer may build from (null when they can't build). */
  catalogue: BiCatalogueAnswer | null;
  /** Modules the viewer can read. */
  modules: ModuleId[];
  canCreate: boolean;
}) {
  const router = useRouter();
  const currency = useWorkspaceCurrency();
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState(false);
  const { idx } = useWorkspace();
  const name = (id: string | null) => (id ? (idx.users.get(id)?.name ?? "Someone") : "Nobody");
  const scopes = modules.filter((m) => MODULES_WITH_DATA.has(m));
  const scopeModule = scope ? biScopeModule(scope) : null;
  const restricted = useMemo(
    () => (catalogue ? biRestrictCatalogue(biDatasets, catalogue.datasets) : []),
    [catalogue],
  );
  // Shipped templates, cut to what this person can read; one with no data left isn't offered.
  const shipped = useMemo(
    () =>
      biTemplates(currency)
        .filter((t) => modules.includes(t.module))
        .map((t) => ({ ...t, spec: biFitSpecToCatalogue(t.spec, restricted) }))
        .filter((t) => biDataWidgetCount(t.spec) > 0),
    [currency, modules, restricted],
  );
  const moduleTemplate = scopeModule ? shipped.find((t) => t.module === scopeModule) : undefined;

  async function startFromModuleTemplate() {
    if (!moduleTemplate || !scope) return;
    setStarting(true);
    try {
      const created = await unwrap(
        browserApi().v1.workspaces[":slug"].bi.dashboards.$post({
          param: { slug },
          json: {
            title: moduleTemplate.title,
            description: moduleTemplate.description,
            scope,
            spec: moduleTemplate.spec,
          },
        }),
      );
      toast.success("Draft saved: adjust it, then ask a dashboard manager to publish it");
      router.push(`/${slug}/dashboards/${created.id}/edit`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="workspace-content flex flex-col gap-4 py-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={scope ?? ALL}
          onValueChange={(v) => router.push(`/${slug}/dashboards${v === ALL ? "" : `?scope=${v}`}`)}
        >
          <SelectTrigger size="sm" className="w-56" aria-label="Show dashboards for">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All dashboards</SelectItem>
            <SelectItem value="workspace">Whole workspace</SelectItem>
            {scopes.map((m) => (
              <SelectItem key={m} value={`module:${m}`}>
                {moduleManifest[m].name}
              </SelectItem>
            ))}
            {scopeModule && !scopes.includes(scopeModule) && (
              <SelectItem value={`module:${scopeModule}`}>{moduleManifest[scopeModule].name}</SelectItem>
            )}
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" asChild className="md:ml-auto">
          <Link href={`/${slug}/dashboards/packs`}>
            <BookCopy /> Board packs
          </Link>
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link href={`/${slug}/dashboards/glossary`}>
            <BookOpen /> Glossary
          </Link>
        </Button>
        {canCreate && (
          <>
            <Button size="sm" variant="outline" onClick={() => setImporting(true)}>
              <FileJson /> Import JSON
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus /> New dashboard
            </Button>
          </>
        )}
      </div>
      {dashboards.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutDashboard />
            </EmptyMedia>
            <EmptyTitle>
              {scopeModule ? `No ${moduleManifest[scopeModule].name} dashboards yet` : "No dashboards yet"}
            </EmptyTitle>
            <EmptyDescription>
              {canCreate
                ? moduleTemplate
                  ? `Start from the ${moduleTemplate.title} template, or build your own. It stays your draft until someone who manages dashboards publishes it.`
                  : "Build one from scratch or a template, import JSON, or ask your AI agent to make one."
                : "Dashboards appear here once someone publishes one to you."}
            </EmptyDescription>
          </EmptyHeader>
          {canCreate && moduleTemplate && (
            <EmptyContent>
              <Button onClick={() => void startFromModuleTemplate()} disabled={starting}>
                {starting ? <Spinner data-icon="inline-start" /> : <LayoutTemplate />} Start from{" "}
                {moduleTemplate.title}
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <ul className="divide-y rounded-lg border">
          {dashboards.map((d) => (
            <li key={d.id}>
              <Link
                href={`/${slug}/dashboards/${d.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
              >
                <LayoutDashboard className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{d.title}</div>
                  {d.description && (
                    <div className="truncate text-sm text-muted-foreground">{d.description}</div>
                  )}
                </div>
                {d.template && <Badge variant="outline">Template</Badge>}
                {d.scope !== "workspace" && (
                  <Badge variant="outline">
                    {(() => {
                      const m = biScopeModule(d.scope);
                      return m ? moduleManifest[m].name : d.scope;
                    })()}
                  </Badge>
                )}
                <Badge variant={d.status === "published" ? "secondary" : "outline"}>
                  {d.status === "published" ? "Published" : "Draft"}
                </Badge>
                <span className="hidden w-32 truncate text-right text-xs text-muted-foreground sm:block">
                  {name(d.ownerId)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {importing && <ImportDialog slug={slug} onClose={() => setImporting(false)} />}
      {creating && (
        <NewDashboardDialog
          slug={slug}
          scope={scope}
          scopes={scopes}
          shipped={shipped}
          templates={templates}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

const BLANK = "blank";

/**
 * A new draft: blank, from a shipped template (cut to the data the person can read), or from a
 * dashboard someone saved as a template. It opens in the builder.
 */
function NewDashboardDialog({
  slug,
  scope,
  scopes,
  shipped,
  templates,
  onClose,
}: {
  slug: string;
  scope?: string;
  scopes: ModuleId[];
  shipped: BiTemplate[];
  templates: DashboardSummary[];
  onClose: () => void;
}) {
  const router = useRouter();
  const scopeModule = scope ? biScopeModule(scope) : null;
  const preferred = scopeModule ? shipped.find((t) => t.module === scopeModule) : undefined;
  const [source, setSource] = useState(preferred ? `shipped:${preferred.id}` : BLANK);
  const [title, setTitle] = useState(preferred?.title ?? "");
  const [titleTouched, setTitleTouched] = useState(false);
  const [target, setTarget] = useState(scope ?? (preferred ? `module:${preferred.module}` : "workspace"));
  const [pending, setPending] = useState(false);

  function choose(value: string) {
    setSource(value);
    const shippedPick = shipped.find((t) => `shipped:${t.id}` === value);
    const saved = templates.find((t) => `saved:${t.id}` === value);
    if (!titleTouched) setTitle(shippedPick?.title ?? saved?.title ?? "");
    if (shippedPick && !scope) setTarget(`module:${shippedPick.module}`);
    if (saved && !scope) setTarget(saved.scope);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    const api = browserApi().v1.workspaces[":slug"].bi.dashboards;
    const name = title.trim() || "Untitled dashboard";
    try {
      const shippedPick = shipped.find((t) => `shipped:${t.id}` === source);
      const saved = templates.find((t) => `saved:${t.id}` === source);
      const created = saved
        ? await unwrap(
            api[":id"].duplicate.$post({
              param: { slug, id: saved.id },
              json: { title: name, scope: target },
            }),
          )
        : await unwrap(
            api.$post({
              param: { slug },
              json: {
                title: name,
                ...(shippedPick ? { description: shippedPick.description } : {}),
                scope: target,
                spec: shippedPick?.spec ?? biEmptySpec(),
              },
            }),
          );
      const omitted = "omittedWidgets" in created ? Number(created.omittedWidgets) : 0;
      if (omitted > 0) toast.info(omittedNotice(omitted));
      router.push(`/${slug}/dashboards/${created.id}/edit`);
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={create}>
          <DialogHeader>
            <DialogTitle>New dashboard</DialogTitle>
            <DialogDescription>
              It starts as your draft. Only you, and people who manage dashboards, see it until it is
              published.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel>Start from</FieldLabel>
              <RadioGroup value={source} onValueChange={choose} className="max-h-72 gap-1 overflow-y-auto">
                <SourceOption value={BLANK} title="Blank" description="An empty dashboard you fill in." />
                {shipped.map((t) => (
                  <SourceOption
                    key={t.id}
                    value={`shipped:${t.id}`}
                    title={t.title}
                    description={`${moduleManifest[t.module].name} template. ${t.description}`}
                  />
                ))}
                {templates.map((t) => (
                  <SourceOption
                    key={t.id}
                    value={`saved:${t.id}`}
                    title={t.title}
                    description={t.description ?? "Saved as a template in this workspace."}
                  />
                ))}
              </RadioGroup>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="bi-new-title">Title</FieldLabel>
                <Input
                  id="bi-new-title"
                  value={title}
                  maxLength={120}
                  placeholder="Untitled dashboard"
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setTitleTouched(true);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="bi-new-scope">Belongs to</FieldLabel>
                <Select value={target} onValueChange={setTarget}>
                  <SelectTrigger id="bi-new-scope" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="workspace">The whole workspace</SelectItem>
                    {scopes.map((m) => (
                      <SelectItem key={m} value={`module:${m}`}>
                        {moduleManifest[m].name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />} Create and edit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SourceOption({ value, title, description }: { value: string; title: string; description: string }) {
  const id = `bi-source-${value}`;
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
    >
      <RadioGroupItem value={value} id={id} className="mt-0.5" />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

/**
 * Saves a dashboard spec pasted as JSON as a new draft (until the builder exists). The server
 * validates it and answers with the path of the first problem.
 */
function ImportDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [json, setJson] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    let spec: unknown;
    try {
      spec = JSON.parse(json);
    } catch {
      setProblem("That isn't valid JSON.");
      return;
    }
    // Accept a whole dashboard ({ title, spec }) or just its spec.
    const body =
      spec && typeof spec === "object" && "spec" in spec
        ? {
            ...(spec as Record<string, unknown>),
            title: title || (spec as { title?: string }).title || "Dashboard",
          }
        : { title: title || "Dashboard", spec };
    setPending(true);
    setProblem(null);
    try {
      const created = await unwrap(
        browserApi().v1.workspaces[":slug"].bi.dashboards.$post({ param: { slug }, json: body as never }),
      );
      toast.success("Draft saved");
      router.push(`/${slug}/dashboards/${created.id}/edit`);
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Import a dashboard</DialogTitle>
            <DialogDescription>
              Paste a dashboard spec. It is saved as your draft; only you (and people who manage dashboards)
              can see it until it is published.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="bi-title">Title</FieldLabel>
              <Input id="bi-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
            </Field>
            <Field>
              <FieldLabel htmlFor="bi-json">Spec (JSON)</FieldLabel>
              <Textarea
                id="bi-json"
                required
                className="h-64 font-mono text-xs"
                value={json}
                onChange={(e) => setJson(e.target.value)}
                aria-invalid={Boolean(problem)}
              />
              <FieldDescription className={problem ? "text-destructive" : undefined}>
                {problem ?? "Sections of widgets, each with a query over the dataset catalogue."}
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />} Save draft
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
