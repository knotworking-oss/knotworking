"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  biAddSection,
  biAddWidget,
  biDashboardSpecSchema,
  biDatasets,
  biFindWidget,
  biIssuesByWidget,
  biMoveSection,
  biMoveWidget,
  biNewWidget,
  biPeriodPresets,
  biRemoveSection,
  biRemoveWidget,
  biRenameSection,
  biReplaceWidget,
  biRestrictCatalogue,
  biUniqueId,
  biWidgetQuery,
  biWidgetTypes,
  biZodIssues,
  BI_LIMITS,
  checkBiDashboard,
  modules as moduleManifest,
  type BiDashboardSpec,
  type BiDataset,
  type BiIssue,
  type BiWidget,
  type ModuleId,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@knotworking/ui/components/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@knotworking/ui/components/sheet";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import { Textarea } from "@knotworking/ui/components/textarea";
import { cn } from "@knotworking/ui/lib/utils";
import {
  ArrowDown,
  ArrowUp,
  CopyPlus,
  Eye,
  GripVertical,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  IssueList,
  SpecJson,
  WidgetEditor,
  WIDGET_TYPE_META,
  type LoadChoices,
} from "@/components/dashboard-editor";
import { DashboardWidget, type WidgetData } from "@/components/dashboard-widgets";
import { PageHeader } from "@/components/page-header";
import type { BiCatalogueAnswer, DashboardDetail } from "@/lib/api";
import { ApiError, browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { humanize } from "@/lib/bi-format";
import { useWorkspaceCurrency } from "@/lib/workspace-time";

interface Draft {
  title: string;
  description: string;
  scope: string;
  spec: BiDashboardSpec;
}

/** Undo steps kept; edits within this many ms of each other (typing) count as one step. */
const HISTORY = 50;
const COALESCE_MS = 800;

/** Modules with data in the catalogue: the ones a dashboard can belong to. */
const MODULES_WITH_DATA = new Set<ModuleId>(biDatasets.flatMap((d) => (d.virtual ? [] : [d.module])));

/**
 * The dashboard builder: the dashboard's settings, its sections, and a
 * 12-column grid of widgets that can be dragged into place, each with a live preview. A widget is
 * edited in a side sheet built from the viewer's own catalogue. Problems are checked as you go with
 * the same rules as the server, which checks again on save.
 */
export function DashboardBuilder(props: {
  slug: string;
  dashboard: DashboardDetail;
  catalogue: BiCatalogueAnswer;
  modules: ModuleId[];
}) {
  const parsed = useMemo(() => biDashboardSpecSchema.safeParse(props.dashboard.spec), [props.dashboard.spec]);
  if (!parsed.success) {
    // Never start from an empty spec: saving it would overwrite the stored one.
    return (
      <UnreadableSpec
        slug={props.slug}
        dashboard={props.dashboard}
        issues={biZodIssues(parsed.error, "spec")}
      />
    );
  }
  return <Builder {...props} spec={parsed.data} />;
}

/** A stored spec the builder can't read (an older or hand-written one): shown, never overwritten. */
function UnreadableSpec({
  slug,
  dashboard,
  issues,
}: {
  slug: string;
  dashboard: DashboardDetail;
  issues: BiIssue[];
}) {
  return (
    <>
      <PageHeader>
        <h1 className="truncate font-medium">Edit: {dashboard.title}</h1>
      </PageHeader>
      <div className="mx-auto flex max-w-4xl flex-1 flex-col gap-4 overflow-y-auto p-6">
        <p className="text-sm">
          This dashboard's definition doesn't match the current format, so the builder can't open it without
          losing parts of it. Fix it through the API or your AI agent (the problems are listed below), or
          start a new dashboard.
        </p>
        <IssueList issues={issues} />
        <SpecJson value={dashboard.spec} />
        <Button variant="outline" className="self-start" asChild>
          <Link href={`/${slug}/dashboards/${dashboard.id}`}>Back to the dashboard</Link>
        </Button>
      </div>
    </>
  );
}

function Builder({
  slug,
  dashboard,
  catalogue: answer,
  modules,
  spec: initialSpec,
}: {
  slug: string;
  dashboard: DashboardDetail;
  catalogue: BiCatalogueAnswer;
  modules: ModuleId[];
  spec: BiDashboardSpec;
}) {
  const router = useRouter();
  const currency = useWorkspaceCurrency();
  const catalogue = useMemo(() => biRestrictCatalogue(biDatasets, answer.datasets), [answer]);
  const initial = useMemo<Draft>(
    () => ({
      title: dashboard.title,
      description: dashboard.description ?? "",
      scope: dashboard.scope,
      spec: initialSpec,
    }),
    [dashboard, initialSpec],
  );
  const [draft, setDraft] = useState<Draft>(initial);
  const [saved, setSaved] = useState<Draft>(initial);
  const [version, setVersion] = useState(dashboard.version);
  const [history, setHistory] = useState<Draft[]>([]);
  /** The last edit's key and time: typing in one field within COALESCE_MS is one undo step. */
  const lastEdit = useRef<{ key: string | null; at: number }>({ key: null, at: 0 });
  const [editing, setEditing] = useState<string | null>(null);
  const [tab, setTab] = useState<"design" | "json">("design");
  const [saving, setSaving] = useState(false);
  const [serverIssues, setServerIssues] = useState<BiIssue[]>([]);
  const [lastDataset, setLastDataset] = useState<string | undefined>(catalogue[0]?.id);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  /**
   * Applies an edit with an undo step. `key` names a field being typed in: consecutive edits of the
   * same key within COALESCE_MS share one step. Structural edits (no key) always get their own.
   */
  const update = useCallback((fn: (d: Draft) => Draft, key?: string) => {
    setDraft((current) => {
      const next = fn(current);
      if (next === current) return current;
      const now = Date.now();
      const last = lastEdit.current;
      const coalesce = key !== undefined && last.key === key && now - last.at <= COALESCE_MS;
      if (!coalesce) setHistory((h) => [...h.slice(-(HISTORY - 1)), current]);
      lastEdit.current = { key: key ?? null, at: now };
      return next;
    });
    setServerIssues([]);
  }, []);
  const setSpec = useCallback(
    (fn: (s: BiDashboardSpec) => BiDashboardSpec, key?: string) =>
      update((d) => {
        const spec = fn(d.spec);
        // A no-op (a section already at the edge, a drop onto its own place) adds no undo step.
        return spec === d.spec || JSON.stringify(spec) === JSON.stringify(d.spec) ? d : { ...d, spec };
      }, key),
    [update],
  );

  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((h) => h.slice(0, -1));
    lastEdit.current = { key: null, at: 0 };
    // Server issues point at widgets by position: stale once the spec changes.
    setServerIssues([]);
    setDraft(previous);
  }

  // The same checks the server runs on save, against what this person may read.
  const issues = useMemo(() => {
    const parsed = biDashboardSpecSchema.safeParse(draft.spec);
    if (!parsed.success) return biZodIssues(parsed.error);
    return checkBiDashboard(parsed.data, catalogue);
  }, [draft.spec, catalogue]);
  const allIssues = serverIssues.length ? serverIssues : issues;
  const byWidget = useMemo(() => biIssuesByWidget(draft.spec, allIssues), [draft.spec, allIssues]);
  const widgetCount = draft.spec.sections.reduce((n, s) => n + s.widgets.length, 0);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const updated = await unwrap(
        browserApi().v1.workspaces[":slug"].bi.dashboards[":id"].$patch({
          param: { slug, id: dashboard.id },
          json: {
            title: draft.title.trim() || "Untitled dashboard",
            description: draft.description.trim() || null,
            scope: draft.scope,
            spec: draft.spec,
            expectedVersion: version,
          },
        }),
      );
      setVersion(updated.version);
      setSaved(draft);
      toast.success("Dashboard saved");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "dashboard_conflict") {
        toast.error("Someone else saved this dashboard. Copy your changes from the JSON tab, then reload.");
      } else if (err instanceof ApiError && err.code === "invalid_dashboard") {
        const list = (err.details as { issues?: BiIssue[] } | undefined)?.issues ?? [];
        setServerIssues(list.map((i) => ({ ...i, path: i.path.replace(/^spec\./, "") })));
        toast.error("The dashboard has problems; they are marked below.");
      } else {
        toast.error(errorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  }, [draft, version, slug, dashboard.id, router]);

  // ⌘S saves; leaving with unsaved changes asks first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty && !saving) void save();
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    // In-app links (the sidebar, breadcrumbs, the View button) ask before leaving unsaved changes.
    const onClick = (e: MouseEvent) => {
      if (!dirty || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank") return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      if (!window.confirm("Leave without saving your changes?")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onLeave);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, saving, save]);

  function addWidget(sectionId: string, type: (typeof biWidgetTypes)[number]) {
    if (widgetCount >= BI_LIMITS.widgets) {
      toast.error(`A dashboard holds at most ${BI_LIMITS.widgets} widgets.`);
      return;
    }
    const dataset = catalogue.find((d) => d.id === lastDataset) ?? catalogue[0];
    const widget = biNewWidget(draft.spec, type, dataset);
    setSpec((s) => biAddWidget(s, sectionId, widget));
    setEditing(widget.id);
  }

  function duplicateWidget(id: string) {
    const found = biFindWidget(draft.spec, id);
    if (!found || widgetCount >= BI_LIMITS.widgets) return;
    const copy = { ...structuredClone(found.widget), id: biUniqueId(draft.spec, found.widget.id) };
    setSpec((s) => {
      const added = biAddWidget(s, found.sectionId, copy);
      return biMoveWidget(added, copy.id, found.sectionId, found.index + 1);
    });
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function onDragEnd(e: DragEndEvent) {
    const active = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    if (!over || over === active) return;
    if (over.startsWith("section:")) {
      const sectionId = over.slice(8);
      const target = draft.spec.sections.find((s) => s.id === sectionId);
      if (target) setSpec((s) => biMoveWidget(s, active, sectionId, target.widgets.length));
      return;
    }
    const to = biFindWidget(draft.spec, over);
    if (to) setSpec((s) => biMoveWidget(s, active, to.sectionId, to.index));
  }

  const loadChoices = useLoadChoices(slug, catalogue);
  const preview = usePreviewCache(slug);
  const editingWidget = editing ? biFindWidget(draft.spec, editing)?.widget : undefined;
  const scopes = modules.filter((m) => MODULES_WITH_DATA.has(m));

  return (
    <>
      <PageHeader
        actions={
          <>
            <Tabs value={tab} onValueChange={(v) => setTab(v as "design" | "json")}>
              <TabsList>
                <TabsTrigger value="design">Design</TabsTrigger>
                <TabsTrigger value="json">JSON</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              size="sm"
              variant="ghost"
              onClick={undo}
              disabled={history.length === 0}
              aria-label="Undo"
            >
              <Undo2 />
              <span className="hidden lg:inline">Undo</span>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link href={`/${slug}/dashboards/${dashboard.id}`}>
                <Eye />
                <span className="hidden lg:inline">View</span>
              </Link>
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
              {saving && <Spinner data-icon="inline-start" />}
              {dirty ? "Save" : "Saved"}
            </Button>
          </>
        }
      >
        <h1 className="truncate font-medium">Edit: {draft.title || "Untitled dashboard"}</h1>
        {dirty && (
          <Badge variant="outline" className="shrink-0">
            Unsaved
          </Badge>
        )}
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        {tab === "json" ? (
          <div className="mx-auto flex max-w-4xl flex-col gap-3 p-6">
            <p className="text-sm text-muted-foreground">
              The dashboard as the API stores it. It is read-only here: change it in the Design tab, or
              through your AI agent.
            </p>
            <SpecJson
              value={{
                title: draft.title,
                description: draft.description || undefined,
                scope: draft.scope,
                spec: draft.spec,
              }}
            />
          </div>
        ) : (
          <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
            {catalogue.length === 0 && (
              <p className="rounded-md border p-3 text-sm text-muted-foreground">
                You can't read any of the data dashboards use yet, so only text widgets can be added. Ask an
                admin for access to a module such as Stock or Purchasing.
              </p>
            )}
            <SettingsCard
              draft={draft}
              catalogue={catalogue}
              scopes={scopes}
              issues={byWidget.get("") ?? []}
              onChange={update}
            />
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              {draft.spec.sections.map((section, i) => (
                <SectionEditor
                  key={section.id}
                  section={section}
                  first={i === 0}
                  last={i === draft.spec.sections.length - 1}
                  only={draft.spec.sections.length === 1}
                  onRename={(title) =>
                    setSpec((s) => biRenameSection(s, section.id, title), `section:${section.id}`)
                  }
                  onMove={(delta) => setSpec((s) => biMoveSection(s, section.id, delta))}
                  onRemove={() => setSpec((s) => biRemoveSection(s, section.id))}
                  onAdd={(type) => addWidget(section.id, type)}
                  canAddData={catalogue.length > 0}
                >
                  {section.widgets.map((widget) => (
                    <SortableWidget key={widget.id} widget={widget}>
                      {(handle) => (
                        <BuilderTile
                          widget={widget}
                          spec={draft.spec}
                          slug={slug}
                          currency={currency}
                          preview={preview}
                          issues={byWidget.get(widget.id) ?? []}
                          handle={handle}
                          onEdit={() => setEditing(widget.id)}
                          onDuplicate={() => duplicateWidget(widget.id)}
                          onRemove={() => setSpec((s) => biRemoveWidget(s, widget.id))}
                        />
                      )}
                    </SortableWidget>
                  ))}
                </SectionEditor>
              ))}
            </DndContext>
            <Button
              variant="outline"
              className="self-start"
              disabled={draft.spec.sections.length >= BI_LIMITS.sections}
              onClick={() => setSpec((s) => biAddSection(s, "New section"))}
            >
              <Plus /> Add section
            </Button>
            <p className="text-xs text-muted-foreground">
              {widgetCount}/{BI_LIMITS.widgets} widgets. Previews use the dashboard's default period and no
              filters. Version {version}.
            </p>
          </div>
        )}
      </div>
      <Sheet open={Boolean(editingWidget)} onOpenChange={(open) => !open && setEditing(null)}>
        <SheetContent className="w-full gap-0 sm:max-w-xl">
          <SheetHeader className="border-b">
            <SheetTitle>Edit widget</SheetTitle>
            <SheetDescription>
              Changes show at once in the preview. Only data you can read is offered.
            </SheetDescription>
          </SheetHeader>
          {editingWidget && (
            <div className="flex flex-col gap-5 overflow-y-auto p-4">
              {editingWidget.type !== "text" && (
                <div className="grid grid-cols-12">
                  <PreviewWidget
                    widget={{ ...editingWidget, display: { ...editingWidget.display, width: 12 } }}
                    spec={draft.spec}
                    slug={slug}
                    currency={currency}
                    preview={preview}
                  />
                </div>
              )}
              <WidgetEditor
                widget={editingWidget}
                spec={draft.spec}
                catalogue={catalogue}
                issues={byWidget.get(editingWidget.id) ?? []}
                loadChoices={loadChoices}
                onChange={(next) => {
                  if (next.type !== "text") setLastDataset(next.query.dataset);
                  setSpec((s) => biReplaceWidget(s, next), `widget:${next.id}`);
                }}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Title, description, where it belongs, the default period and the filters viewers can set. */
function SettingsCard({
  draft,
  catalogue,
  scopes,
  issues,
  onChange,
}: {
  draft: Draft;
  catalogue: readonly BiDataset[];
  scopes: ModuleId[];
  issues: BiIssue[];
  onChange: (fn: (d: Draft) => Draft, key?: string) => void;
}) {
  const spec = draft.spec;
  const setParams = (params: BiDashboardSpec["params"]) =>
    onChange((d) => ({ ...d, spec: { ...d.spec, params } }));
  // Fields a dashboard filter can use: those of the datasets on the dashboard (or every dataset).
  const used = new Set(
    spec.sections.flatMap((s) => s.widgets.flatMap((w) => (w.type === "text" ? [] : [w.query.dataset]))),
  );
  const dims = new Map<string, string>();
  for (const d of catalogue.filter((d) => used.size === 0 || used.has(d.id)))
    for (const dim of d.dimensions) if (dim.type !== "date" && !dims.has(dim.id)) dims.set(dim.id, dim.label);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Dashboard</CardTitle>
      </CardHeader>
      <CardContent>
        <FieldGroup className="gap-4">
          <IssueList issues={issues} />
          <div className="grid gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="bi-title">Title</FieldLabel>
              <Input
                id="bi-title"
                value={draft.title}
                maxLength={120}
                onChange={(e) => onChange((d) => ({ ...d, title: e.target.value }), "title")}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="bi-scope">Belongs to</FieldLabel>
              <Select value={draft.scope} onValueChange={(scope) => onChange((d) => ({ ...d, scope }))}>
                <SelectTrigger id="bi-scope" className="w-full">
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
          <Field>
            <FieldLabel htmlFor="bi-description">Description</FieldLabel>
            <Textarea
              id="bi-description"
              className="min-h-16"
              value={draft.description}
              maxLength={1000}
              onChange={(e) => onChange((d) => ({ ...d, description: e.target.value }), "description")}
            />
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="bi-period">Default period</FieldLabel>
              <Select
                value={spec.params.period?.preset ?? "none"}
                onValueChange={(v) => {
                  const { period: _old, ...rest } = spec.params;
                  setParams(
                    v === "none"
                      ? rest
                      : { ...rest, period: { preset: v as (typeof biPeriodPresets)[number] } },
                  );
                }}
              >
                <SelectTrigger id="bi-period" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None: each widget sets its own</SelectItem>
                  {biPeriodPresets.map((p) => (
                    <SelectItem key={p} value={p}>
                      {humanize(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="flex flex-col gap-2">
            <FieldLabel>Filters viewers can set</FieldLabel>
            {spec.params.filters.map((f, i) => (
              <div key={f.id} className="flex items-center gap-2">
                <Input
                  aria-label="Filter label"
                  className="w-48"
                  value={f.label}
                  maxLength={60}
                  onChange={(e) =>
                    setParams({
                      ...spec.params,
                      filters: spec.params.filters.map((x, j) =>
                        j === i ? { ...x, label: e.target.value } : x,
                      ),
                    })
                  }
                />
                <Select
                  value={f.dim}
                  onValueChange={(dim) =>
                    setParams({
                      ...spec.params,
                      filters: spec.params.filters.map((x, j) =>
                        j === i
                          ? {
                              ...x,
                              dim,
                              label: x.label === dims.get(x.dim) ? (dims.get(dim) ?? x.label) : x.label,
                            }
                          : x,
                      ),
                    })
                  }
                >
                  <SelectTrigger className="w-56" aria-label="Filter field">
                    <SelectValue placeholder={f.dim} />
                  </SelectTrigger>
                  <SelectContent>
                    {[...dims].map(([id, label]) => (
                      <SelectItem key={id} value={id}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Remove filter"
                  onClick={() =>
                    setParams({ ...spec.params, filters: spec.params.filters.filter((_, j) => j !== i) })
                  }
                >
                  <X />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={spec.params.filters.length >= BI_LIMITS.params || dims.size === 0}
              onClick={() => {
                const [dim, label] =
                  [...dims].find(([id]) => !spec.params.filters.some((f) => f.dim === id)) ?? [...dims][0]!;
                setParams({
                  ...spec.params,
                  filters: [...spec.params.filters, { id: biUniqueId(spec, dim), label, dim }],
                });
              }}
            >
              <Plus /> Add filter
            </Button>
          </div>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

function SectionEditor({
  section,
  first,
  last,
  only,
  onRename,
  onMove,
  onRemove,
  onAdd,
  canAddData,
  children,
}: {
  section: BiDashboardSpec["sections"][number];
  first: boolean;
  last: boolean;
  only: boolean;
  onRename: (title: string) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onAdd: (type: (typeof biWidgetTypes)[number]) => void;
  canAddData: boolean;
  children: ReactNode;
}) {
  // Only an empty section is a drop target of its own: in a populated one the widgets are, so a
  // drop between two of them lands there rather than at the end.
  const { setNodeRef, isOver } = useDroppable({
    id: `section:${section.id}`,
    disabled: section.widgets.length > 0,
  });
  return (
    <section className="flex flex-col gap-3" aria-label={section.title || "Section"}>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Section title"
          placeholder="Section title (optional)"
          className="h-8 max-w-sm font-medium"
          value={section.title}
          maxLength={120}
          onChange={(e) => onRename(e.target.value)}
        />
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Move section up"
            disabled={first}
            onClick={() => onMove(-1)}
          >
            <ArrowUp />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Move section down"
            disabled={last}
            onClick={() => onMove(1)}
          >
            <ArrowDown />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Remove section (its widgets move to the one above)"
            title="Remove section (its widgets move to the one above)"
            disabled={only}
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <Plus /> Add widget
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {biWidgetTypes.map((t) => (
                <DropdownMenuItem key={t} disabled={t !== "text" && !canAddData} onSelect={() => onAdd(t)}>
                  {WIDGET_TYPE_META[t].icon}
                  {WIDGET_TYPE_META[t].label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <SortableContext items={section.widgets.map((w) => w.id)} strategy={rectSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            "grid min-h-24 grid-cols-1 gap-4 rounded-lg md:grid-cols-12",
            section.widgets.length === 0 && "place-items-center border border-dashed",
            isOver && "bg-muted/40",
          )}
        >
          {section.widgets.length === 0 ? (
            <p className="col-span-full text-sm text-muted-foreground">Add a widget, or drag one here.</p>
          ) : (
            children
          )}
        </div>
      </SortableContext>
    </section>
  );
}

/** A grid cell that can be dragged by its handle (or picked up with the keyboard: Space, arrows, Space). */
function SortableWidget({
  widget,
  children,
}: {
  widget: BiWidget;
  children: (handle: ReactNode) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({
      id: widget.id,
    });
  const span = widget.display?.width ?? (widget.type === "kpi" ? 3 : 6);
  return (
    <div
      ref={setNodeRef}
      className={cn("relative min-w-0", isDragging && "z-10 opacity-70")}
      style={{
        gridColumn: `span ${span} / span ${span}`,
        transform: CSS.Translate.toString(transform),
        transition,
      }}
    >
      {children(
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="cursor-grab rounded p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
          aria-label={`Move ${widget.title || "widget"}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>,
      )}
    </div>
  );
}

function BuilderTile({
  widget,
  spec,
  slug,
  currency,
  preview,
  issues,
  handle,
  onEdit,
  onDuplicate,
  onRemove,
}: {
  widget: BiWidget;
  spec: BiDashboardSpec;
  slug: string;
  currency: string;
  preview: PreviewCache;
  issues: BiIssue[];
  handle: ReactNode;
  onEdit: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex h-full flex-col rounded-xl",
        issues.length > 0 && "ring-2 ring-destructive/50",
      )}
    >
      <div className="flex items-center gap-1 px-1 pb-1">
        {handle}
        <span className="flex items-center gap-1 text-xs text-muted-foreground [&_svg]:size-3.5">
          {WIDGET_TYPE_META[widget.type].icon}
          {WIDGET_TYPE_META[widget.type].label}
        </span>
        {issues.length > 0 && (
          <span
            className="flex items-center gap-1 text-xs text-destructive"
            title={issues.map((i) => i.message).join("\n")}
          >
            <TriangleAlert className="size-3.5" />{" "}
            {issues.length === 1 ? "1 problem" : `${issues.length} problems`}
          </span>
        )}
        <div className="ml-auto flex items-center">
          <Button size="icon-sm" variant="ghost" aria-label="Edit widget" onClick={onEdit}>
            <Pencil />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Duplicate widget" onClick={onDuplicate}>
            <CopyPlus />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Remove widget" onClick={onRemove}>
            <Trash2 />
          </Button>
        </div>
      </div>
      <div
        className="grid flex-1 cursor-pointer grid-cols-12"
        role="button"
        tabIndex={-1}
        onClick={onEdit}
        aria-label={`Edit ${widget.title || "widget"}`}
      >
        <PreviewWidget
          widget={{ ...widget, display: { ...widget.display, width: 12 } } as BiWidget}
          spec={spec}
          slug={slug}
          currency={currency}
          preview={preview}
          skip={issues.length > 0}
        />
      </div>
    </div>
  );
}

// ─── Live preview ────────────────────────────────────────────────────────────

type PreviewCache = (spec: string) => Promise<WidgetData>;

/** Runs a widget's query through `/bi/query`, remembering answers while the builder is open. */
function usePreviewCache(slug: string): PreviewCache {
  const cache = useRef(new Map<string, Promise<WidgetData>>());
  return useCallback(
    (spec: string) => {
      const hit = cache.current.get(spec);
      if (hit) return hit;
      const run = unwrap(
        browserApi().v1.workspaces[":slug"].bi.query.$get({ param: { slug }, query: { spec } }),
      )
        .then((result): WidgetData => ({ widgetId: "", status: "ok", result: result as never }))
        .catch((err): WidgetData => {
          cache.current.delete(spec);
          if (
            err instanceof ApiError &&
            (err.code === "module_forbidden" || err.code === "bi_field_forbidden")
          )
            return { widgetId: "", status: "no_access", message: err.message };
          return {
            widgetId: "",
            status: "error",
            code: err instanceof ApiError ? err.code : "error",
            message: errorMessage(err),
          };
        });
      cache.current.set(spec, run);
      return run;
    },
    [slug],
  );
}

/** A widget as the viewer will see it, with its query run as you edit (debounced). */
function PreviewWidget({
  widget,
  spec,
  slug,
  currency,
  preview,
  skip = false,
}: {
  widget: BiWidget;
  spec: BiDashboardSpec;
  slug: string;
  currency: string;
  preview: PreviewCache;
  /** Don't run a query the checks already refuse. */
  skip?: boolean;
}) {
  const key = widget.type === "text" || skip ? null : JSON.stringify(biWidgetQuery(widget, spec));
  const [state, setState] = useState<{ key: string; data: WidgetData } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void preview(key).then((data) => !cancelled && setState({ key, data }));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, preview]);
  const data = key && state?.key === key ? { ...state.data, widgetId: widget.id } : undefined;
  return (
    <DashboardWidget
      widget={widget}
      data={
        skip
          ? {
              widgetId: widget.id,
              status: "error",
              code: "invalid",
              message: "Fix the problems marked above to see it.",
            }
          : data
      }
      loading={Boolean(key) && !data}
      base={`/${slug}`}
      workspaceCurrency={currency}
    />
  );
}

/** Loads the values a field takes (references, categories without a fixed list) with a count query. */
function useLoadChoices(slug: string, catalogue: readonly BiDataset[]): LoadChoices {
  return useCallback<LoadChoices>(
    async (datasetId, dim) => {
      const dataset = catalogue.find((d) => d.id === datasetId);
      const counter = dataset?.measures.find((m) => m.unit === "count");
      if (!dataset || !counter) return [];
      const res = await unwrap(
        browserApi().v1.workspaces[":slug"].bi.query.$get({
          param: { slug },
          query: {
            spec: JSON.stringify({
              dataset: datasetId,
              measures: [counter.id],
              groupBy: [{ dim }],
              sort: [{ by: dim, dir: "asc" }],
              limit: 200,
            }),
          },
        }),
      );
      const idKey = `${dim}__id`;
      return res.rows.flatMap((row) => {
        const id = row[idKey] ?? row[dim];
        return id === null || id === undefined
          ? []
          : [{ value: String(id), label: humanize(String(row[dim] ?? id)) }];
      });
    },
    [slug, catalogue],
  );
}
