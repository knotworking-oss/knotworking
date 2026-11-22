"use client";

import {
  salesStatuses,
  complaintStatuses,
  correctiveActionStatuses,
  nonconformanceStatuses,
  qualitySeverities,
  lineReceiptStates,
  purchaseOrderStates,
  purchaseCreditNoteStatuses,
  purchaseInvoiceStatuses,
  invoiceMatchStatuses,
  nutritionPanel,
  nutritionSources,
  parseSegmentsMarkup,
  productLabelStatuses,
  d,
  demandSources,
  checkSignOffStatuses,
  dueStates,
  glassConditions,
  pestActivityLevels,
  siteProgrammes,
  haccpHazardTypes,
  haccpPlanVersionStatuses,
  lotStatuses,
  planVersionStates,
  planIssues,
  productionBatchStatuses,
  trainingStatuses,
  priorityLabels,
  projectHealths,
  projectStatuses,
  sopVersionStatuses,
  supplierApprovalStatuses,
  tagColors,
  workflowStateTypes,
  type DocContent,
  type Priority,
  localIsoDate,
  type TagColorName,
} from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Badge } from "@knotworking/ui/components/badge";
import { BlockedBadge } from "@knotworking/ui/components/blocked-badge";
import { Button } from "@knotworking/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { ColorPicker } from "@knotworking/ui/components/color-picker";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@knotworking/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@knotworking/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@knotworking/ui/components/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@knotworking/ui/components/input-group";
import { Kbd, KbdGroup } from "@knotworking/ui/components/kbd";
import { Label } from "@knotworking/ui/components/label";
import { ColorDot, LabelBadge } from "@knotworking/ui/components/label-badge";
import { Popover, PopoverContent, PopoverTrigger } from "@knotworking/ui/components/popover";
import { PriorityIcon } from "@knotworking/ui/components/priority-icon";
import { ProjectHealthBadge, ProjectStatusBadge } from "@knotworking/ui/components/project-badges";
import { PropertyMenu } from "@knotworking/ui/components/property-menu";
import { Progress } from "@knotworking/ui/components/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { RadioGroup, RadioGroupItem } from "@knotworking/ui/components/radio-group";
import { Separator } from "@knotworking/ui/components/separator";
import { Skeleton } from "@knotworking/ui/components/skeleton";
import { Spinner } from "@knotworking/ui/components/spinner";
import { StatusIcon } from "@knotworking/ui/components/status-icon";
import { ResultBadge, TokenActionRow } from "@/components/token-action-row";
import { Switch } from "@knotworking/ui/components/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import { Textarea } from "@knotworking/ui/components/textarea";
import { EstimateVariance, TimeReportTable } from "@knotworking/ui/components/time-report-table";
import { TimerButton, TimeSummary } from "@knotworking/ui/components/time-tracking";
import { ToggleGroup, ToggleGroupItem } from "@knotworking/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@knotworking/ui/components/tooltip";
import { UserAvatar } from "@knotworking/ui/components/user-avatar";
import {
  ArrowLeft,
  ArrowRight,
  Bold,
  Copy,
  Inbox,
  Italic,
  Kanban,
  List,
  Lock,
  Mail,
  Plus,
  Search,
  Settings,
  Terminal,
  Trash2,
  Underline,
} from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { DocEditor } from "@/components/doc-editor/doc-editor";
import { SaveStatusText } from "@/components/doc-editor/save-status";
import { ModeToggle } from "@/components/mode-toggle";
import { stackedTable } from "@/components/stacked-table";
import { GanttChart, type GanttTask } from "@/components/gantt-chart";
import { TrendChart } from "@/components/trend-chart";
import { ChartDemo } from "@/components/chart-demo";
import { DashboardEditorDemo } from "@/components/dashboard-editor-demo";
import { DashboardWidgetsDemo } from "@/components/dashboard-widgets-demo";
import { SnapshotViewDemo } from "@/components/snapshot-view-demo";
import { AnalysisViewDemo } from "@/components/analysis-view-demo";
import { TimeEntryForm } from "@/components/task-time";
import { AttachmentRow, UploadRow } from "@/components/task-attachments";
import { fromDay, toDay } from "@/lib/timeline";
import { AllergenBadges, SupplierApprovalBadge } from "@/components/item-badges";
import { AllergenMismatchAlert, RecipeVersionBadge } from "@/components/recipe-badges";
import {
  SpecificationBlockers,
  SpecificationChanges,
  SpecificationDiscrepancies,
  SpecificationReviewBadge,
  SpecificationVersionBadge,
} from "@/components/specification-badges";
import { NpdChecklist, NpdStatusBadge } from "@/components/npd-badges";
import {
  DefenceDueBadge,
  DefenceExerciseBadge,
  DefenceRatingBadge,
  DefenceVersionBadge,
} from "@/components/defence-badges";
import {
  GovernanceComplianceBadge,
  GovernanceConcernBadge,
  GovernanceCultureBadge,
  GovernanceDueBadge,
  GovernanceObjectiveStatusBadge,
  GovernanceRagBadge,
} from "@/components/governance-badges";
import { ReleaseChecklist } from "@/components/release-check";
import {
  TestInvestigationBadge,
  TestOutcomeBadge,
  TestPlanDueBadge,
  TestSampleStatusBadge,
} from "@/components/testing-badges";
import { SopFlagBadge, SopReviewBadge, SopVersionStatusBadge } from "@/components/sop-badges";
import { KioskBadgeCard } from "@/components/kiosk-badge";
import { KioskPinBadge, StaffNumber, StaffStatusBadge } from "@/components/people-badges";
import { TrainingCell, TrainingStatusBadge } from "@/components/training-badges";
import { ExpiryBadge, formatAmount, LotStatusBadge } from "@/components/stock-badges";
import { DemandRowErrors, DemandSourceBadge, WeekHeading } from "@/components/demand-badges";
import {
  BatchStatusBadge,
  GapBadge,
  MassBalance,
  PlanIssueBadge,
  ShortfallBadge,
} from "@/components/production-badges";
import {
  ApiSourceBadge,
  CorrectiveActionBadge,
  DueStateBadge,
  HazardBadge,
  PlanVersionBadge,
  PlanVersionStateBadge,
  ReadingBadge,
  ReviewStatusBadge,
} from "@/components/haccp-badges";
import { HaccpBatchPanel } from "@/components/haccp-batch-panel";
import { AssistantMessageView } from "@/components/assistant-message";
import { CcpCheckDialog, CheckSheetDialog, CorrectReadingDialog } from "@/components/haccp-forms";
import { HaccpNav } from "@/components/haccp-nav";
import { ProcessFlow } from "@/components/process-flow";
import {
  AuditStateBadge,
  ComplaintStatusBadge,
  NonconformanceStatusBadge,
  RecallResultBadge,
  RecallScheduleBadge,
  SeverityBadge,
} from "@/components/quality-badges";
import { SsccBarcode } from "@/components/sscc-barcode";
import { DistributionOperationsRecord } from "@/components/distribution-operations-record";
import { ReturnReceipts } from "@/components/return-receipts";
import { IncidentOverview } from "@/components/incident-overview";
import { AuthenticityReview, AuthenticityStatus } from "@/components/authenticity-review";
import { demoAuthenticityVersion, demoAuthenticitySummary } from "./demo-records";
import { QualityNav } from "@/components/quality-nav";
import {
  LineReceiptStateBadge,
  OverdueBadge,
  PerformancePercent,
  PurchaseOrderStateBadge,
  ReceiptOutcomeBadge,
  ReceivedProgress,
} from "@/components/purchasing-badges";
import { PurchasingNav } from "@/components/purchasing-nav";
import {
  CreditNoteStatusBadge,
  InvoiceStatusBadge,
  MatchIssues,
  MatchStatusBadge,
  MatchVariance,
} from "@/components/invoice-badges";
import { BatchCostPanel } from "@/components/batch-cost-panel";
import {
  CostSourceBadge,
  EstimatedBadge,
  IncompleteCostBadge,
  ProvisionalBadge,
  VarianceValue,
} from "@/components/costing-badges";
import { CostingNav } from "@/components/costing-nav";
import { demoBatchCost } from "./demo-costing";
import {
  ActivityBadge,
  BreakageBadge,
  ConditionBadge,
  OutcomeBadge,
  ProgrammeBadge,
  SignOffBadge,
} from "@/components/site-badges";
import { SiteNav } from "@/components/site-nav";
import { AuditRecordList } from "@/components/audit-record-list";
import { ExportCsvButton } from "@/components/export-csv-button";
import { LabelPreview, type LabelPreviewContent } from "@/components/label-preview";
import { DateRangeForm, PrintHeading, PrintNotice, SignatureLine } from "@/components/print-page";
import type { AuditEntry } from "@/lib/audit-records";
import { labelPrintState } from "@/lib/label-print";
import { LabelStatusBadge, NutritionSourceBadge, StaleLabelBadge } from "@/components/labels-badges";
import { LabelsNav } from "@/components/labels-nav";
import { MemberCard } from "@/components/member-avatar";
import { OrgChart } from "@/components/org-chart";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@knotworking/ui/components/hover-card";
import { DistributionImpact } from "@/components/distribution-impact";
import { LotTrace } from "@/components/lot-trace";
import { demoBatchRecord, demoCcps, demoLotTrace, demoDistributionImpact } from "./demo-records";
import { LotBarcode } from "@/components/lot-barcode";
import { ModuleAccessTable, type ModuleAccessMember } from "@/components/module-access-table";
import { TimeReportFilters } from "@/components/time-report-filters";
import { presetRange, type ReportFilters } from "@/lib/time-report";
import { HseAttention } from "@/components/hse-attention";
import { SalesStatusBadge } from "@/components/sales-status-badge";
import { useAutosave } from "@/lib/use-autosave";

const sections = [
  ["foundations", "Foundations"],
  ["buttons", "Buttons"],
  ["forms", "Forms"],
  ["display", "Badges & avatars"],
  ["sales", "Sales documents"],
  ["hse", "HSE attention"],
  ["knotworking", "Status & priority"],
  ["time", "Time tracking"],
  ["timeline", "Timeline"],
  ["charts", "Charts"],
  ["dashboard-widgets", "Dashboard widgets"],
  ["dashboard-editor", "Dashboard builder"],
  ["snapshot-view", "Board snapshots"],
  ["analysis-view", "Agent analyses"],
  ["time-report", "Time reports"],
  ["api-access", "API access"],
  ["cards", "Cards & tables"],
  ["navigation", "Tabs & toggles"],
  ["overlays", "Overlays"],
  ["feedback", "Feedback"],
  ["attachments", "Attachments"],
  ["assistant", "Assistant"],
  ["editor", "Editor"],
  ["print", "Print & export"],
] as const;

const people = ["Ada Park", "Marcus Chen", "Priya Raman", "Tomás Silva", "Noor Haddad"];

export function Showcase() {
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-6 border-r bg-sidebar p-4 lg:flex">
        <Link href="/" className="flex items-center gap-2 px-2 font-semibold">
          <ArrowLeft className="size-4 text-muted-foreground" /> Knotworking
        </Link>
        <nav className="flex flex-col gap-0.5 text-sm">
          {sections.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {label}
            </a>
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="mx-auto flex max-w-5xl flex-col gap-16 px-8 py-12">
          <header className="flex items-start justify-between gap-6">
            <div className="flex flex-col gap-3">
              <Badge variant="secondary">shadcn/ui · Radix · Nova</Badge>
              <h1 className="text-4xl font-semibold tracking-tight">Design system</h1>
              <p className="max-w-2xl text-muted-foreground">
                Knotworking is built on shadcn/ui: accessible Radix primitives, Tailwind CSS and theme
                variables, with components we own in{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">packages/ui</code>. On top
                sit a few Knotworking pieces — status and priority icons, label badges and avatars.
              </p>
            </div>
            <ModeToggle />
          </header>

          <Section
            id="foundations"
            title="Foundations"
            description="Theme variables from packages/ui/src/styles/globals.css. Every color has a light and dark value."
          >
            <Swatches
              title="Theme"
              items={[
                ["background", "bg-background"],
                ["foreground", "bg-foreground"],
                ["primary", "bg-primary"],
                ["secondary", "bg-secondary"],
                ["muted", "bg-muted"],
                ["accent", "bg-accent"],
                ["destructive", "bg-destructive"],
                ["border", "bg-border"],
                ["card", "bg-card"],
                ["sidebar", "bg-sidebar"],
              ]}
            />
            <Swatches
              title="Workflow status"
              items={[
                ["status-backlog", "bg-status-backlog"],
                ["status-unstarted", "bg-status-unstarted"],
                ["status-started", "bg-status-started"],
                ["status-completed", "bg-status-completed"],
                ["status-canceled", "bg-status-canceled"],
              ]}
            />
            <Swatches
              title="Priority"
              items={[
                ["priority-urgent", "bg-priority-urgent"],
                ["priority-high", "bg-priority-high"],
                ["priority-medium", "bg-priority-medium"],
                ["priority-low", "bg-priority-low"],
                ["priority-none", "bg-priority-none"],
              ]}
            />
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">Labels</h3>
              <div className="flex flex-wrap gap-2">
                {tagColors.map((c) => (
                  <LabelBadge key={c} color={c} variant="tint">
                    {cap(c)}
                  </LabelBadge>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                {tagColors.map((c) => (
                  <LabelBadge key={c} color={c}>
                    {cap(c)}
                  </LabelBadge>
                ))}
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardDescription>Geist Sans</CardDescription>
                  <CardTitle className="text-2xl">Plan, track and document</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-1 text-sm">
                  <p className="text-4xl font-semibold tracking-tight">Aa</p>
                  <p className="text-muted-foreground">text-xs · sm · base · lg · xl · 2xl · 3xl · 4xl</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Geist Mono</CardDescription>
                  <CardTitle className="font-mono text-lg">tasks.create()</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-1 text-sm">
                  <p className="font-mono text-muted-foreground">const task = await api.tasks.create()</p>
                  <p className="text-muted-foreground">Radius: rounded-sm · md · lg · xl (from --radius)</p>
                </CardContent>
              </Card>
            </div>
          </Section>

          <Section id="buttons" title="Buttons">
            <Demo>
              <div className="flex flex-col gap-4">
                {(["default", "secondary", "outline", "ghost", "destructive", "link"] as const).map(
                  (variant) => (
                    <div key={variant} className="flex flex-wrap items-center gap-2">
                      <code className="w-24 font-mono text-xs text-muted-foreground">{variant}</code>
                      {(["xs", "sm", "default", "lg"] as const).map((size) => (
                        <Button key={size} variant={variant} size={size}>
                          {variant === "destructive" ? <Trash2 /> : <Plus />}
                          {variant === "destructive" ? "Delete" : "New task"}
                        </Button>
                      ))}
                    </div>
                  ),
                )}
                <Separator />
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled>
                    <Spinner /> Saving
                  </Button>
                  <Button variant="outline">
                    Continue <ArrowRight />
                  </Button>
                  {[Copy, Settings, Mail].map((I, i) => (
                    <Button key={i} variant="outline" size="icon" aria-label="Icon button">
                      <I />
                    </Button>
                  ))}
                  <Button variant="ghost" size="icon-sm" aria-label="Add">
                    <Plus />
                  </Button>
                </div>
              </div>
            </Demo>
          </Section>

          <Section
            id="forms"
            title="Forms"
            description="Field composes label, control, description and error with consistent spacing."
          >
            <Demo>
              <FieldGroup className="grid gap-6 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="title">Task title</FieldLabel>
                  <Input id="title" placeholder="e.g. Crash when pasting images" />
                  <FieldDescription>Keep it short and specific.</FieldDescription>
                </Field>
                <Field data-invalid>
                  <FieldLabel htmlFor="email">Email</FieldLabel>
                  <Input id="email" defaultValue="ada@" aria-invalid />
                  <FieldError>That doesn&apos;t look like an email address.</FieldError>
                </Field>
                <Field>
                  <FieldLabel htmlFor="search">Search</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <Search />
                    </InputGroupAddon>
                    <InputGroupInput id="search" placeholder="Search tasks, docs…" />
                    <InputGroupAddon align="inline-end">
                      <KbdGroup>
                        <Kbd>⌘</Kbd>
                        <Kbd>K</Kbd>
                      </KbdGroup>
                    </InputGroupAddon>
                  </InputGroup>
                </Field>
                <Field>
                  <FieldLabel>Priority</FieldLabel>
                  <Select defaultValue="2">
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Set priority" />
                    </SelectTrigger>
                    <SelectContent>
                      {([1, 2, 3, 4, 0] as Priority[]).map((p) => (
                        <SelectItem key={p} value={String(p)}>
                          <PriorityIcon priority={p} /> {priorityLabels[p]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field className="md:col-span-2">
                  <FieldLabel htmlFor="desc">Description</FieldLabel>
                  <Textarea id="desc" placeholder="Add a description…" />
                </Field>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <Checkbox id="c1" defaultChecked />
                    <Label htmlFor="c1">Notify assignee</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox id="c2" />
                    <Label htmlFor="c2">Create another</Label>
                  </div>
                </div>
                <RadioGroup defaultValue="read" aria-label="Access level">
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="read" id="r1" />
                    <Label htmlFor="r1">Read only</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="write" id="r2" />
                    <Label htmlFor="r2">Read and write</Label>
                  </div>
                </RadioGroup>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="s1">Email notifications</Label>
                    <Switch id="s1" defaultChecked />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="s2">Weekly digest</Label>
                    <Switch id="s2" />
                  </div>
                </div>
              </FieldGroup>
            </Demo>
          </Section>

          <Section id="hse" title="HSE attention">
            <Demo>
              <HseAttention
                attention={{ reviewOverdue: true, openFailures: 2, state: "overdue", dueOn: "2026-11-01" }}
              />
              <p className="mt-3 text-sm text-muted-foreground">
                A later pass does not silently close an unresolved failure. Signed inspection and risk reviews
                retain prior evidence.
              </p>
            </Demo>
          </Section>

          <Section id="sales" title="Sales documents">
            <Demo>
              <div className="flex flex-wrap gap-2">
                {salesStatuses.map((status) => (
                  <SalesStatusBadge key={status} status={status} />
                ))}
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                Quotes become orders through a retained conversion; only confirmed orders form daily sales
                commitments.
              </p>
            </Demo>
          </Section>

          <Section id="display" title="Badges & avatars">
            <Demo>
              <div className="flex flex-col gap-5">
                <div className="flex flex-wrap items-center gap-2">
                  {(["default", "secondary", "outline", "destructive"] as const).map((v) => (
                    <Badge key={v} variant={v}>
                      {cap(v)}
                    </Badge>
                  ))}
                  <LabelBadge color="red">Client request</LabelBadge>
                  <LabelBadge color="purple">Content</LabelBadge>
                  <LabelBadge color="purple" variant="tint">
                    🚀 Winter product launch
                  </LabelBadge>
                  <BlockedBadge count={1} />
                  <BlockedBadge count={2} showLabel />
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  {["size-5", "size-6", "size-8", "size-10"].map((s) => (
                    <UserAvatar key={s} name="Priya Raman" className={s} />
                  ))}
                  <div className="flex -space-x-2">
                    {people.map((p) => (
                      <UserAvatar key={p} name={p} className="size-8 ring-2 ring-background" />
                    ))}
                  </div>
                </div>
                <ColorPickerDemo />
                <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                  Shortcuts:
                  <KbdGroup>
                    <Kbd>⌘</Kbd>
                    <Kbd>K</Kbd>
                  </KbdGroup>
                  <Kbd>C</Kbd>
                  <KbdGroup>
                    <Kbd>G</Kbd>
                    <Kbd>I</Kbd>
                  </KbdGroup>
                </div>
              </div>
            </Demo>
          </Section>

          <Section
            id="knotworking"
            title="Status & priority"
            description="Knotworking-specific glyphs. Shape carries the meaning so they read without color."
          >
            <Demo>
              <div className="grid gap-6 sm:grid-cols-3">
                <div className="flex flex-col gap-2.5 text-sm">
                  {workflowStateTypes.map((t) => (
                    <div key={t} className="flex items-center gap-2">
                      <StatusIcon type={t} /> {cap(t)}
                    </div>
                  ))}
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <StatusIcon type="started" progress={0.75} /> In Review (75%)
                  </div>
                </div>
                <div className="flex flex-col gap-2.5 text-sm">
                  {([1, 2, 3, 4, 0] as Priority[]).map((p) => (
                    <div key={p} className="flex items-center gap-2">
                      <PriorityIcon priority={p} /> {priorityLabels[p]}
                    </div>
                  ))}
                </div>
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Winter product launch</span>
                      <span>40%</span>
                    </div>
                    <Progress value={40} aria-label="Progress" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Customer survey</span>
                      <span>100%</span>
                    </div>
                    <Progress value={100} aria-label="Progress" />
                  </div>
                </div>
              </div>
            </Demo>
            <Demo>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-medium">Project status & health</h3>
                  <p className="text-sm text-muted-foreground">
                    <code className="font-mono text-xs">ProjectStatusBadge</code> is neutral;{" "}
                    <code className="font-mono text-xs">ProjectHealthBadge</code> carries the color. Project
                    cards show health when it is set and the status otherwise.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {projectStatuses.map((s) => (
                    <ProjectStatusBadge key={s} status={s} />
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {projectHealths.map((h) => (
                    <ProjectHealthBadge key={h} health={h} />
                  ))}
                </div>
              </div>
            </Demo>
            <Demo>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-medium">Property menus</h3>
                  <p className="text-sm text-muted-foreground">
                    <code className="font-mono text-xs">PropertyMenu</code>: searchable pickers for task
                    properties, with single-key shortcuts. Used in list rows, board cards, the task sidebar
                    and the new-task dialog.
                  </p>
                </div>
                <PropertyMenuDemo />
              </div>
            </Demo>
          </Section>

          <Section
            id="time"
            title="Time tracking"
            description="TimeSummary shows logged against estimated time (compact on task rows, with a bar on the task and project pages; red when over). TimerButton starts and stops the viewer's timer. TimeEntryForm logs or edits an entry and reads durations like 1h 30m, 1.5h, 90 or 1:30."
          >
            <TimeDemo />
          </Section>

          <Section
            id="timeline"
            title="Timeline"
            description="GanttChart: a project's tasks as bars from start to due date (a diamond when only one date is set), coloured by status, with the assignee, an overdue edge, dependency arrows (dashed red when the blocked task starts before its blocker ends), the project's start-to-target range and today. Drag a bar to move it or its edges to change the dates; focus one and use the arrow keys (Shift to change the due date, Alt+Shift the start date)."
          >
            <TimelineDemo />
          </Section>

          <Section
            id="trend-chart"
            title="Trend chart"
            description="TrendChart: a small bar chart of a value over time as plain SVG, one bar per point, the maximum labelled on the axis, flagged points in the destructive colour. Used for pest sightings per visit on the pest control page."
          >
            <div className="flex flex-wrap items-end gap-8">
              <TrendChart
                ariaLabel="Sightings per visit"
                unit="sightings"
                points={[
                  { label: "1 Sep", value: 0 },
                  { label: "1 Oct", value: 2 },
                  { label: "1 Nov", value: 5, flag: true },
                  { label: "1 Dec", value: 1 },
                ]}
              />
              <TrendChart
                ariaLabel="A clear device"
                points={[
                  { label: "1 Sep", value: 0 },
                  { label: "1 Oct", value: 0 },
                ]}
              />
            </div>
          </Section>

          <Section
            id="charts"
            title="Charts"
            description="Chart (shadcn, Recharts): ChartContainer, ChartTooltip and ChartLegend around Recharts marks. Series take --chart-1 to --chart-5 in fixed order, never cycled; light and dark have their own steps. Thin marks, 4px rounded bar ends, 2px lines, a legend for two or more series, a tooltip on hover. Dashboard widgets are built on it."
          >
            <ChartDemo />
          </Section>

          <Section
            id="dashboard-widgets"
            title="Dashboard widgets"
            description="DashboardWidget: one card per widget of a dashboard spec: KPI with its change against the comparison period (in red when it moved the wrong way; goodDirection says which way is good), line, bar, stacked bar, donut, table and pivot, built on Chart; text is labelled commentary. No access, error, empty and loading states have their own tile so one widget never breaks the page. More series than the five palette slots fold into Other. Each data widget links to its records and exports CSV."
          >
            <DashboardWidgetsDemo />
          </Section>

          <Section
            id="dashboard-editor"
            title="Dashboard builder"
            description="WidgetEditor: the builder's form for one widget, offering only the datasets, measures and fields in the viewer's own catalogue. Type picker, measures (with how a split measure must be grouped), groupings that fit the type, filters whose value input suits the field (choices for categories and references), the period (follow the dashboard or pin one), comparison, sort, rows, width and KPI direction. Changing type refits the query. IssueList shows problems with their path, as the server would refuse them; SpecJson is the read-only JSON view with a copy button."
          >
            <DashboardEditorDemo />
          </Section>

          <Section
            id="snapshot-view"
            title="Board snapshots"
            description="SnapshotBody: a dashboard frozen as at a date, rendered from its stored results and never re-queried, with the dashboard and catalogue versions it was taken with. Given the previous snapshot of the same dashboard, a table compares the KPIs both share (then, now, change). Board packs show one per section, under their commentary. Certified metrics carry a check badge whose tooltip gives their definition and version."
          >
            <SnapshotViewDemo />
          </Section>

          <Section
            id="analysis-view"
            title="Agent analyses"
            description="AnalysisView: a scenario comparison an AI agent built through MCP and Knotworking verified. The question, each scenario with what it assumes (the first is the baseline), every figure per scenario with its change from the baseline, and per figure (click it) where each number came from: its formula and every cited value with the path and source it was read from. The agent's summary is labelled commentary. Figures are hidden from readers who can't read every source's module."
          >
            <AnalysisViewDemo />
          </Section>

          <Section
            id="time-report"
            title="Time reports"
            description="The Time page: filters for period, project, team, person and grouping (kept in the URL), an Export CSV link, and a table of logged against estimated time. EstimateVariance spells out how far over (red, up arrow) or under (muted, down arrow) the estimate a row is, and shows a dash when there is nothing to compare."
          >
            <TimeReportDemo />
          </Section>

          <Section
            id="api-access"
            title="API access"
            description="Settings → API access. TokenActionRow shows an action a token may be allowed to do: label, the access level it needs, a switch (disabled for non-admins) and who allowed it and when. ResultBadge marks audit-log rows: ok for 2xx, otherwise the HTTP status."
          >
            <ApiAccessDemo />
          </Section>

          <Section id="cards" title="Cards & tables">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Team offsite</CardTitle>
                  <CardDescription>
                    Two days together in February: planning, workshops and a team dinner.
                  </CardDescription>
                  <CardAction>
                    <Badge className="border-transparent bg-label-yellow-bg text-label-yellow">At risk</Badge>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <Progress value={25} aria-label="Progress" />
                </CardContent>
                <CardFooter className="justify-between border-t text-xs text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <UserAvatar name="Tomás Silva" className="size-5" /> Tomás Silva
                  </span>
                  Due Jan 30
                </CardFooter>
              </Card>
              <Card className="py-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Task</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="pr-4 text-right">Assignee</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      ["Prepare proposal for Northwind", "started", "Marcus Chen"],
                      ["Design launch graphics", "started", "Noor Haddad"],
                      ["Set up a shared team calendar", "completed", "Tomás Silva"],
                    ].map(([title, type, who]) => (
                      <TableRow key={title}>
                        <TableCell className="pl-4">{title}</TableCell>
                        <TableCell>
                          <StatusIcon type={type as "started"} />
                        </TableCell>
                        <TableCell className="pr-4">
                          <UserAvatar name={who!} className="ml-auto size-5" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
              <Card className="py-0 md:col-span-2">
                {/* Below md each row becomes a card (narrow the window to see it); no sideways scrolling. */}
                <Table className={stackedTable}>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Course</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Trained</TableHead>
                      <TableHead className="pr-4" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      ["FS-01", "Food safety level 2", "completed", "3 Aug 2026"],
                      ["FORK", "Counterbalance forklift operator", "started", "—"],
                    ].map(([code, title, type, on]) => (
                      <TableRow key={code}>
                        <TableCell className="pl-4" data-primary>
                          <span className="mr-2 font-mono text-xs">{code}</span>
                          {title}
                        </TableCell>
                        <TableCell data-label="Status">
                          <StatusIcon type={type as "started"} />
                        </TableCell>
                        <TableCell data-label="Trained">{on}</TableCell>
                        <TableCell className="pr-4 text-right" data-actions>
                          <Button variant="outline" size="sm">
                            Record
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            </div>
          </Section>

          <Section
            id="items"
            title="Items and suppliers"
            description="Allergen badges (contains, and dashed for may contain) and supplier approval status, used on the Items and Suppliers pages."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <AllergenBadges
                  contains={["cereals_gluten", "milk", "eggs"]}
                  mayContain={["nuts", "sesame"]}
                />
                <AllergenBadges contains={[]} />
                <div className="flex flex-wrap gap-2">
                  {supplierApprovalStatuses.map((status) => (
                    <SupplierApprovalBadge key={status} status={status} />
                  ))}
                </div>
              </div>
            </Demo>
          </Section>

          <Section
            id="stock"
            title="Stock"
            description="Lot status (only available lots are picked) and expiry: red once a date has passed, amber within a week, plain otherwise. Quantities show in the item's own unit."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  {lotStatuses.map((status) => (
                    <LotStatusBadge key={status} status={status} />
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <ExpiryBadge expiresOn="2026-11-10" expiryType="use_by" today="2026-11-11" />
                  <ExpiryBadge expiresOn="2026-11-14" expiryType="use_by" today="2026-11-11" />
                  <ExpiryBadge expiresOn="2027-06-30" expiryType="best_before" today="2026-11-11" />
                  <ExpiryBadge expiresOn={null} expiryType={null} />
                </div>
                <p className="text-sm tabular-nums">
                  {formatAmount({ display: 12.5, displayUnit: "kg" })} ·{" "}
                  {formatAmount({ display: 0.75, displayUnit: "l" })} ·{" "}
                  {formatAmount({ display: 240, displayUnit: "each" })}
                </p>
              </div>
            </Demo>
          </Section>

          <Section
            id="demand"
            title="Demand"
            description="Where a demand line's quantity came from, week headings for the plan grid (ISO week over its Monday), and the per-row problems a CSV import reports before anything is written."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  {demandSources.map((source) => (
                    <DemandSourceBadge key={source} source={source} />
                  ))}
                </div>
                <div className="flex gap-6 text-sm font-medium">
                  <WeekHeading periodStart="2026-11-09" />
                  <WeekHeading periodStart="2026-11-16" />
                  <WeekHeading periodStart="2026-12-28" />
                </div>
                <DemandRowErrors
                  errors={[
                    { row: 3, column: "item", message: 'No item has the code "CAKE-9"' },
                    { row: 7, column: "period", message: '"next week" is not a date or week' },
                    { row: 12, column: "unit", message: "SOUP-1 is measured in l; each can't be converted" },
                  ]}
                />
              </div>
            </Demo>
          </Section>

          <Section
            id="production"
            title="Production"
            description="Batch status on the schedule and batch pages, whether stock covers a material requirement, the gap and planning issues on the plan-from-demand page, a lot's mass balance, and the production trace on a stock lot page (made from, used in, mass balance; static data here)."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  {productionBatchStatuses.map((status) => (
                    <BatchStatusBadge key={status} status={status} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <ShortfallBadge shortfall={{ display: 0, displayUnit: "kg" }} />
                  <ShortfallBadge shortfall={{ display: 2.5, displayUnit: "kg" }} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <GapBadge gap={{ display: 0, displayUnit: "each" }} />
                  <GapBadge gap={{ display: 18, displayUnit: "each" }} />
                  {planIssues.map((issue) => (
                    <PlanIssueBadge key={issue} issue={issue} />
                  ))}
                </div>
                <div className="max-w-xs">
                  <MassBalance
                    balance={{
                      received: { display: 25, displayUnit: "kg" },
                      returned: { display: 0, displayUnit: "kg" },
                      produced: { display: 0, displayUnit: "kg" },
                      consumed: { display: 18, displayUnit: "kg" },
                      despatched: { display: 0, displayUnit: "kg" },
                      wasted: { display: 0.5, displayUnit: "kg" },
                      adjusted: { display: -0.2, displayUnit: "kg" },
                      onHand: { display: 6.3, displayUnit: "kg" },
                      adjustedPercent: -0.8,
                    }}
                  />
                </div>
                <LotTrace slug="acme" trace={demoLotTrace} />
                <DistributionImpact slug="acme" report={demoDistributionImpact} timeZone="Europe/London" />
                <DistributionOperationsRecord
                  record={{
                    allocatedAt: "2026-11-14T09:00:00.000Z",
                    packedAt: "2026-11-14T09:30:00.000Z",
                    loadCheck: null,
                  }}
                  operations={{
                    packages: [
                      {
                        id: "demo-pack",
                        reference: "Pallet A",
                        sscc: "000000000000000017",
                        contents: [{ lineId: "demo-line", quantity: 12 }],
                        supersededAt: null,
                      },
                    ],
                    events: [],
                    proofs: [],
                    returns: [],
                  }}
                  lines={[
                    { id: "demo-line", lotCode: "CAKE-261114", itemName: "Lemon cake", itemUnit: "each" },
                  ]}
                  users={[]}
                  timeZone="Europe/London"
                />
                <p className="text-xs text-muted-foreground">Example SSCC; not for operational use.</p>
                <SsccBarcode sscc="000000000000000017" />
                <ReturnReceipts
                  slug="acme"
                  returns={[
                    {
                      id: "demo-return",
                      lineId: "demo-line",
                      lotId: "demo-lot",
                      originalLotId: "demo-original",
                      lotCode: "RET-261114-1",
                      receivedOn: "2026-11-14",
                      quantity: 2,
                      unit: "each",
                      reason: "Customer withdrawal recovery",
                      condition: "Sealed packs, awaiting QA assessment",
                      createdAt: "2026-11-14T10:00:00.000Z",
                      createdBy: null,
                      voidedAt: null,
                      voidReason: null,
                      incidentId: null,
                    },
                  ]}
                />
              </div>
            </Demo>
          </Section>

          <Section
            id="haccp"
            title="Food safety (HACCP)"
            description="The food safety pages' navigation, where a scheduled check stands, a reading against its critical limit (flagged as it is typed), the hazard a CCP controls, the process flow diagram drawn from a plan version's steps (CCP steps outlined), plan versions under document control and where each stands by its effective date (in force, scheduled for a later date, replaced), corrective actions, the marker on records that came through an API token (an agent or a sensor feed), and where such a reading stands in review (awaiting review, rejected; approved readings carry no badge). The navigation counts the readings awaiting review. Below: the check and correction dialogs (nothing is sent from here) and the food safety panel on a production batch page, with static data."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <HaccpNav slug="acme" awaitingReview={3} />
                <div className="flex flex-wrap gap-2">
                  {dueStates.map((state) => (
                    <DueStateBadge key={state} state={state} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <ReadingBadge withinLimits />
                  <ReadingBadge withinLimits={false} reason="below_min" />
                  <ReadingBadge withinLimits={false} reason="above_max" />
                  <ReadingBadge withinLimits={false} reason="failed" />
                  <ApiSourceBadge />
                  <ReviewStatusBadge status="pending" />
                  <ReviewStatusBadge status="rejected" note="Probe was not in the core" />
                </div>
                <div className="flex flex-wrap gap-2">
                  {haccpHazardTypes.map((type) => (
                    <HazardBadge key={type} type={type} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  {haccpPlanVersionStatuses.map((status) => (
                    <PlanVersionBadge key={status} status={status} />
                  ))}
                  {correctiveActionStatuses.map((status) => (
                    <CorrectiveActionBadge key={status} status={status} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  {planVersionStates.map((state) => (
                    <PlanVersionStateBadge key={state} state={state} />
                  ))}
                </div>
                <ProcessFlow
                  nodes={[
                    {
                      id: "1",
                      number: 1,
                      name: "Receiving",
                      description: null,
                      ccpCodes: [],
                      hazardCount: 1,
                      isCcp: false,
                    },
                    {
                      id: "2",
                      number: 2,
                      name: "Cooking",
                      description: "Kettle, 20 minutes",
                      ccpCodes: ["CCP1"],
                      hazardCount: 1,
                      isCcp: true,
                    },
                    {
                      id: "3",
                      number: 3,
                      name: "Chilling",
                      description: null,
                      ccpCodes: ["CCP2"],
                      hazardCount: 1,
                      isCcp: true,
                    },
                    {
                      id: "4",
                      number: 4,
                      name: "Packing",
                      description: null,
                      ccpCodes: [],
                      hazardCount: 0,
                      isCcp: false,
                    },
                  ]}
                />
                <HaccpFormsDemo />
              </div>
            </Demo>
            <div className="-mx-6">
              <HaccpBatchPanel slug="acme" record={demoBatchRecord} />
            </div>
          </Section>

          <Section
            id="org-chart"
            title="Org chart and member cards"
            description="Hovering a member's avatar shows their card: name, job title and department from the org chart, who they report to, and their workspace role (the title grants nothing; access comes from the role and module access). Hover the avatar below. The org chart page lists everyone as an indented tree; someone whose manager has left sits at the top."
          >
            <Demo>
              <div className="flex flex-col gap-6">
                <div className="flex items-center gap-3">
                  <HoverCard openDelay={150}>
                    <HoverCardTrigger asChild>
                      <span className="inline-flex rounded-full">
                        <UserAvatar name="Marcus Chen" className="size-8" title={null} />
                      </span>
                    </HoverCardTrigger>
                    <HoverCardContent className="w-64" align="start">
                      <MemberCard
                        person={{
                          name: "Marcus Chen",
                          role: "member",
                          title: "Head of Technical",
                          department: "Technical",
                        }}
                        manager="Ada Park"
                      />
                    </HoverCardContent>
                  </HoverCard>
                  <span className="text-sm text-muted-foreground">Hover the avatar</span>
                </div>
                <div className="w-64 rounded-lg p-2.5 shadow-md ring-1 ring-foreground/10">
                  <MemberCard
                    person={{
                      name: "Priya Raman",
                      role: "admin",
                      title: "QA Technician",
                      department: "Technical",
                      email: "priya@example.com",
                    }}
                    manager="Marcus Chen"
                  />
                </div>
                <OrgChart
                  members={[
                    {
                      userId: "a",
                      name: "Ada Park",
                      role: "owner",
                      title: "Managing Director",
                      department: null,
                      reportsToUserId: null,
                    },
                    {
                      userId: "m",
                      name: "Marcus Chen",
                      role: "member",
                      title: "Head of Technical",
                      department: "Technical",
                      reportsToUserId: "a",
                    },
                    {
                      userId: "p",
                      name: "Priya Raman",
                      role: "admin",
                      title: "QA Technician",
                      department: "Technical",
                      reportsToUserId: "m",
                    },
                    {
                      userId: "t",
                      name: "Tomás Silva",
                      role: "member",
                      title: "Production Manager",
                      department: "Production",
                      reportsToUserId: "a",
                    },
                    {
                      userId: "n",
                      name: "Noor Haddad",
                      role: "guest",
                      title: null,
                      department: null,
                      reportsToUserId: null,
                    },
                  ]}
                />
              </div>
            </Demo>
          </Section>

          <Section
            id="quality"
            title="Quality"
            description="The quality pages' navigation; how serious a complaint or non-conformance is; where a complaint, a non-conformance (overdue once past its due date and not closed) and an internal audit stand; a mock recall test's result (voided tests stay listed, struck through); and where the yearly recall test stands."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <QualityNav slug="acme" />
                <AuthenticityStatus assessment={demoAuthenticitySummary} />
                <AuthenticityReview
                  version={demoAuthenticityVersion}
                  verifications={[]}
                  today="2026-11-15"
                  users={[{ id: "auth-ada", name: "Ada Park" }]}
                  slug="acme"
                  timeZone="Europe/London"
                />
                <IncidentOverview
                  ownerName="Ada Lovelace"
                  incident={{
                    id: "demo-case",
                    reference: "INC-000001",
                    title: "Allergen investigation",
                    kind: "recall",
                    severity: "critical",
                    ownerUserId: "ada",
                    status: "open",
                    createdAt: "2026-11-14T09:00:00.000Z",
                    closedAt: null,
                    closedBy: null,
                  }}
                />
                <div className="flex flex-wrap gap-2">
                  {qualitySeverities.map((severity) => (
                    <SeverityBadge key={severity} severity={severity} />
                  ))}
                  {complaintStatuses.map((status) => (
                    <ComplaintStatusBadge key={status} status={status} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  {nonconformanceStatuses.map((status) => (
                    <NonconformanceStatusBadge key={status} status={status} />
                  ))}
                  <NonconformanceStatusBadge status="open" overdue />
                </div>
                <div className="flex flex-wrap gap-2">
                  {(["overdue", "soon", "planned", "completed", "cancelled"] as const).map((state) => (
                    <AuditStateBadge key={state} state={state} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <RecallResultBadge passed />
                  <RecallResultBadge passed={false} />
                  <RecallResultBadge passed voided />
                  {(["never", "overdue", "soon", "ok"] as const).map((state) => (
                    <RecallScheduleBadge key={state} state={state} />
                  ))}
                </div>
              </div>
            </Demo>
          </Section>

          <Section
            id="purchasing"
            title="Purchasing"
            description="The purchasing pages' navigation; where a purchase order stands (part received while any line is short; overdue when something outstanding is past its expected date); where each line stands against what was ordered; a receipt accepted into stock, refused at the door, or reversed on the lot page (struck through, no longer counted); how many lines have arrived in full; supplier performance rates (green from 95%, amber from 80%, a dash when nothing was due); a supplier invoice's status (a corrected one shows its version) and its three-way match; price and quantity variances (red over the order or what arrived, green under) and why a line doesn't simply match."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <PurchasingNav slug="acme" />
                <div className="flex flex-wrap gap-2">
                  {purchaseOrderStates.map((state) => (
                    <PurchaseOrderStateBadge key={state} state={state} />
                  ))}
                  <OverdueBadge />
                </div>
                <div className="flex flex-wrap gap-2">
                  {lineReceiptStates.map((state) => (
                    <LineReceiptStateBadge key={state} state={state} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <ReceiptOutcomeBadge outcome="accepted" />
                  <ReceiptOutcomeBadge outcome="rejected" />
                  <ReceiptOutcomeBadge outcome="accepted" reversed />
                </div>
                <div className="flex flex-wrap items-center gap-6">
                  <ReceivedProgress received={0} total={3} />
                  <ReceivedProgress received={2} total={3} />
                  <ReceivedProgress received={1} total={1} />
                  <div className="flex flex-wrap gap-2">
                    <PerformancePercent value={100} />
                    <PerformancePercent value={87.5} />
                    <PerformancePercent value={33.3} />
                    <PerformancePercent value={null} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {purchaseInvoiceStatuses.map((status) => (
                    <InvoiceStatusBadge key={status} status={status} version={status === "draft" ? 2 : 1} />
                  ))}
                  {invoiceMatchStatuses.map((status) => (
                    <MatchStatusBadge key={status} status={status} />
                  ))}
                  {purchaseCreditNoteStatuses.map((status) => (
                    <CreditNoteStatusBadge key={status} status={status} />
                  ))}
                </div>
                <div className="flex flex-wrap items-start gap-6 text-sm">
                  <MatchVariance value={0.01} percent={1.25} />
                  <MatchVariance value={-0.02} percent={-2.5} />
                  <MatchVariance value={0} />
                  <MatchVariance value={null} />
                  <MatchIssues issues={["price_within_tolerance", "over_invoiced"]} />
                </div>
              </div>
            </Demo>
          </Section>

          <Section
            id="costing"
            title="Costing"
            description="The costing pages' navigation; where a consumed lot's cost comes from (the approved supplier invoice's price; the purchase price on its delivery; the batch that made it, amber when part of that batch's cost was estimated; the item's standard cost when no price is known, an estimate; or nothing at all); variances, actual minus standard, red when adverse and green when favourable; the share of a cost resting on standard costs; provisional figures (the batch or one upstream isn't completed) and an incomplete cost. Then a batch's cost panel in full, as on its costing page, and compact, as on the production batch page."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <CostingNav slug="acme" />
                <div className="flex flex-wrap gap-2">
                  <CostSourceBadge source="invoice" />
                  <CostSourceBadge source="purchase" />
                  <CostSourceBadge source="batch" />
                  <CostSourceBadge source="batch" estimatedPercent={12.5} />
                  <CostSourceBadge source="standard" reason="not_purchased" />
                  <CostSourceBadge source="missing" reason="no_purchase_price" />
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <VarianceValue value={2.75} percent={26.3} currency="GBP" />
                  <VarianceValue value={-0.5526} currency="GBP" />
                  <VarianceValue value={0} currency="GBP" />
                  <VarianceValue value={null} currency="GBP" />
                  <EstimatedBadge percent={9.1} />
                  <ProvisionalBadge />
                  <IncompleteCostBadge codes={["SALT"]} />
                </div>
                <BatchCostPanel slug="acme" currency="GBP" cost={demoBatchCost} />
                <BatchCostPanel slug="acme" currency="GBP" cost={demoBatchCost} compact />
              </div>
            </Demo>
          </Section>

          <Section
            id="site"
            title="Site programmes"
            description="The site pages' navigation (with how many things wait for a person with manage access); which programme a due item belongs to; where each check stands (overdue, due, due soon, up to date); pest activity found at a device; a glass item's condition; a breakage (the area is held until a person releases it); and a pre-start check's result and sign-off."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <SiteNav slug="acme" waiting={{ "/storage": 3, "/checks": 1 }} />
                <div className="flex flex-wrap gap-2">
                  {siteProgrammes.map((programme) => (
                    <ProgrammeBadge key={programme} programme={programme} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  {dueStates.map((state) => (
                    <DueStateBadge key={state} state={state} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  {pestActivityLevels.map((activity) => (
                    <ActivityBadge key={activity} activity={activity} />
                  ))}
                  {glassConditions.map((condition) => (
                    <ConditionBadge key={condition} condition={condition} />
                  ))}
                  <BreakageBadge status="open" />
                  <BreakageBadge status="released" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <OutcomeBadge outcome="passed" />
                  <OutcomeBadge outcome="failed" />
                  {checkSignOffStatuses.map((status) => (
                    <SignOffBadge key={status} status={status} />
                  ))}
                </div>
              </div>
            </Demo>
          </Section>

          <Section
            id="labels"
            title="Labels and nutrition"
            description="The labels pages' navigation; a label's document-control status and the flag on one that needs review (approved) or a refresh (draft), with the reasons as its title; where an item's nutrition comes from; and a label's text as it reads on pack, allergens in bold and the nutrition table rounded as the guidance says."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <LabelsNav slug="acme" />
                <div className="flex flex-wrap gap-2">
                  {productLabelStatuses.map((status) => (
                    <LabelStatusBadge key={status} status={status} versionNumber={2} />
                  ))}
                  <StaleLabelBadge
                    status="approved"
                    reasons={[{ kind: "nutrition_changed", itemCodes: ["BUT"] }]}
                  />
                  <StaleLabelBadge
                    status="draft"
                    reasons={[{ kind: "recipe_version_superseded", itemCodes: [] }]}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {nutritionSources.map((source) => (
                    <NutritionSourceBadge key={source} source={source} />
                  ))}
                </div>
                <div className="max-w-md">
                  <LabelPreview label={demoLabel} />
                </div>
              </div>
            </Demo>
          </Section>

          <Section
            id="sops"
            title="SOPs"
            description="Document-control badges used on the SOPs pages: the state of a version, markers on a list row, and review-date warnings."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  {sopVersionStatuses.map((status) => (
                    <SopVersionStatusBadge key={status} status={status} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <SopFlagBadge kind="draft" />
                  <SopFlagBadge kind="in_review" />
                  <SopFlagBadge kind="acknowledged" />
                  <SopFlagBadge kind="archived" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <SopReviewBadge reviewDueOn="2020-01-01" />
                  <SopReviewBadge reviewDueOn={new Date().toISOString().slice(0, 10)} />
                </div>
              </div>
            </Demo>
          </Section>

          <Section
            id="people"
            title="People"
            description="The staff register: a fixed-width 6-digit staff number, active or leaver, and whether the person can use the kiosk (PIN set, no PIN, or locked after too many wrong PINs). A kiosk badge holds an opaque, revocable code as a QR code, never the staff number or PIN."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StaffNumber value="000042" />
                  <StaffNumber value="100001" />
                  <StaffStatusBadge status="active" />
                  <StaffStatusBadge status="leaver" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <KioskPinBadge hasPin lockedUntil={null} />
                  <KioskPinBadge hasPin={false} lockedUntil={null} />
                  <KioskPinBadge hasPin lockedUntil="2026-11-11T12:00:00Z" />
                </div>
                <KioskBadgeCard name="Grace Hopper" workspaceName="Acme Bakery" code="K7QM2XWP9HRT4CNB" />
              </div>
            </Demo>
          </Section>

          <Section
            id="training"
            title="Training"
            description="Where a person stands on a course: badges on lists, and compact cells in the training matrix (with the status for screen readers). Missing training past its due date shows as overdue."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  {trainingStatuses.map((status) => (
                    <TrainingStatusBadge key={status} status={status} />
                  ))}
                  <TrainingStatusBadge status="missing" overdue />
                </div>
                <div className="flex flex-wrap gap-2">
                  {trainingStatuses
                    .filter((s) => s !== "not_required")
                    .map((status) => (
                      <TrainingCell key={status} status={status} />
                    ))}
                  <TrainingCell status="missing" overdue />
                </div>
              </div>
            </Demo>
          </Section>

          <Section
            id="recipes"
            title="Recipes"
            description="Version status for document control, and the warning shown when the allergens the ingredients bring in don't match the output item's declaration."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  <RecipeVersionBadge status="draft" versionNumber={3} />
                  <RecipeVersionBadge status="approved" versionNumber={2} />
                  <RecipeVersionBadge status="superseded" versionNumber={1} />
                </div>
                <AllergenMismatchAlert mismatch={{ undeclared: ["milk", "nuts"], unexplained: ["eggs"] }} />
              </div>
            </Demo>
          </Section>

          <Section
            id="specifications"
            title="Specifications"
            description="Version and review status, why a draft can't be approved yet, where the item record disagrees with a specification, and what a revision changes."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  <SpecificationVersionBadge status="draft" versionNumber={3} />
                  <SpecificationVersionBadge status="approved" versionNumber={2} />
                  <SpecificationVersionBadge status="superseded" versionNumber={1} />
                  <SpecificationReviewBadge state="due_soon" reviewDueOn="2026-12-01" />
                  <SpecificationReviewBadge state="overdue" reviewDueOn="2026-10-01" />
                  <SpecificationReviewBadge state="none" />
                </div>
                <SpecificationBlockers
                  blockers={["Set a review date", "Record the supplier's agreement (who and when)"]}
                />
                <SpecificationDiscrepancies
                  discrepancies={[
                    {
                      kind: "may_contain_undeclared",
                      severity: "serious",
                      allergens: ["sesame"],
                      message: "The specification may contain Sesame, which the item doesn't mention",
                    },
                    {
                      kind: "storage_differs",
                      severity: "check",
                      message: "The specification says chilled; the item is kept ambient",
                    },
                  ]}
                />
                <SpecificationChanges
                  diff={{
                    fields: [
                      {
                        field: "shelfLifeDays",
                        label: "Shelf life",
                        from: "270 days",
                        to: "240 days",
                        impacting: true,
                      },
                      {
                        field: "countryOfOrigin",
                        label: "Country of origin",
                        from: "—",
                        to: "United Kingdom",
                        impacting: true,
                      },
                    ],
                    parameters: [
                      {
                        change: "changed",
                        category: "chemical",
                        name: "Moisture",
                        from: "≤ 15.5 %",
                        to: "≤ 15 %",
                      },
                      {
                        change: "added",
                        category: "microbiological",
                        name: "Salmonella",
                        from: null,
                        to: "Absent in 25 g",
                      },
                    ],
                    addedAllergens: ["sesame"],
                    removedAllergens: [],
                    impacting: true,
                  }}
                />
              </div>
            </Demo>
          </Section>

          <Section
            id="testing"
            title="Testing"
            description="Result and sample outcomes, sample status, an open investigation after a failure, and where a sampling plan stands against its due date."
          >
            <Demo>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <TestOutcomeBadge outcome="pass" />
                  <TestOutcomeBadge outcome="fail" />
                  <TestOutcomeBadge outcome="pending" />
                  <TestInvestigationBadge status="open" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <TestSampleStatusBadge status="awaiting_results" />
                  <TestSampleStatusBadge status="complete" />
                  <TestSampleStatusBadge status="cancelled" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <TestPlanDueBadge state="overdue" />
                  <TestPlanDueBadge state="due" />
                  <TestPlanDueBadge state="due_soon" />
                  <TestPlanDueBadge state="ok" />
                </div>
              </div>
            </Demo>
          </Section>

          <Section
            id="lot-release"
            title="Lot release"
            description="What releasing a lot is checked against: met, blocking (unless two stock managers agree a release exception with a reason and evidence), or for the record. Checks from the item's release rule are marked."
          >
            <Demo>
              <ReleaseChecklist
                slug="acme"
                checks={[
                  {
                    kind: "tests_pending",
                    status: "block",
                    module: "testing",
                    label: "No test results outstanding",
                    detail: "1 sample is awaiting results",
                    refs: [{ id: "s1", label: "S-2026-0012" }],
                    fromRule: false,
                  },
                  {
                    kind: "required_test",
                    status: "pass",
                    module: "testing",
                    label: "A passing test covering Salmonella",
                    detail: "Passed: S-2026-0009",
                    refs: [],
                    fromRule: true,
                  },
                  {
                    kind: "ccp_review",
                    status: "block",
                    module: "haccp",
                    label: "CCP monitoring reviewed",
                    detail: "2 CCP readings are not approved (0 rejected)",
                    refs: [],
                    fromRule: true,
                    hidden: true,
                  },
                  {
                    kind: "packing_checks",
                    status: "info",
                    module: "stock",
                    label: "Packing checks",
                    detail: "Label, date code and weight checks aren't recorded in Knotworking yet",
                    refs: [],
                    fromRule: false,
                  },
                ]}
              />
            </Demo>
          </Section>

          <Section
            id="governance"
            title="Management review"
            description="Objective progress and status, culture plan activities, compliance with a requirement, confidential concern status, and due dates."
          >
            <Demo>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <GovernanceRagBadge rag="on_track" />
                  <GovernanceRagBadge rag="at_risk" />
                  <GovernanceRagBadge rag="off_track" />
                  <GovernanceObjectiveStatusBadge status="open" />
                  <GovernanceObjectiveStatusBadge status="achieved" />
                  <GovernanceObjectiveStatusBadge status="missed" />
                  <GovernanceObjectiveStatusBadge status="withdrawn" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <GovernanceCultureBadge state="planned" />
                  <GovernanceCultureBadge state="overdue" />
                  <GovernanceCultureBadge state="done" />
                  <GovernanceCultureBadge state="cancelled" />
                  <GovernanceDueBadge status="overdue" />
                  <GovernanceDueBadge status="due_soon" />
                  <GovernanceDueBadge status="ok" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <GovernanceComplianceBadge status="not_assessed" />
                  <GovernanceComplianceBadge status="compliant" />
                  <GovernanceComplianceBadge status="partial" />
                  <GovernanceComplianceBadge status="non_compliant" />
                  <GovernanceConcernBadge status="open" />
                  <GovernanceConcernBadge status="investigating" />
                  <GovernanceConcernBadge status="closed" />
                </div>
              </div>
            </Demo>
          </Section>

          <Section
            id="defence"
            title="Food defence"
            description="Threat ratings from likelihood × impact, where a control's check or an assessment's review stands, assessment versions and exercise outcomes."
          >
            <Demo>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <DefenceRatingBadge rating="low" score={4} />
                  <DefenceRatingBadge rating="medium" score={10} />
                  <DefenceRatingBadge rating="high" score={15} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <DefenceDueBadge status="never" />
                  <DefenceDueBadge status="overdue" />
                  <DefenceDueBadge status="due_soon" />
                  <DefenceDueBadge status="ok" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <DefenceVersionBadge status="draft" />
                  <DefenceVersionBadge status="approved" />
                  <DefenceVersionBadge status="superseded" />
                  <DefenceExerciseBadge outcome="effective" />
                  <DefenceExerciseBadge outcome="partly_effective" />
                  <DefenceExerciseBadge outcome="ineffective" />
                </div>
              </div>
            </Demo>
          </Section>

          <Section
            id="npd"
            title="Product development"
            description="A project's stage, and its launch checklist: read from the records, with people's sign-offs marked, and checks that don't apply shown as such."
          >
            <Demo>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  <NpdStatusBadge status="brief" />
                  <NpdStatusBadge status="trials" />
                  <NpdStatusBadge status="validation" />
                  <NpdStatusBadge status="launched" />
                  <NpdStatusBadge status="cancelled" />
                </div>
                <NpdChecklist
                  checks={[
                    {
                      key: "recipe_approved",
                      label: "Recipe approved",
                      status: "met",
                      detail: "Approved v2",
                      manual: false,
                    },
                    {
                      key: "shelf_life",
                      label: "Shelf life proven",
                      status: "missing",
                      detail: "Best proven 8 days, short of the 10-day target",
                      manual: false,
                    },
                    {
                      key: "label",
                      label: "Product label approved",
                      status: "na",
                      detail: "The Labels module is switched off",
                      manual: false,
                    },
                    {
                      key: "customer_signoff",
                      label: "Customer sign-off",
                      status: "met",
                      detail: "J. Buyer on 2026-11-14 (PO-778)",
                      manual: true,
                    },
                  ]}
                />
              </div>
            </Demo>
          </Section>

          <Section
            id="module-access"
            title="Module access"
            description="Settings → Members: what each person can use, per active module. Owners and admins are fixed at full access; guests can read at most."
          >
            <Card className="overflow-x-auto py-0">
              <ModuleAccessDemo />
            </Card>
          </Section>

          <Section id="navigation" title="Tabs & toggles">
            <Demo>
              <div className="flex flex-col gap-6">
                <Tabs defaultValue="list">
                  <TabsList>
                    <TabsTrigger value="list">
                      <List /> List
                    </TabsTrigger>
                    <TabsTrigger value="board">
                      <Kanban /> Board
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="list" className="pt-2 text-sm text-muted-foreground">
                    Dense rows grouped by status.
                  </TabsContent>
                  <TabsContent value="board" className="pt-2 text-sm text-muted-foreground">
                    Cards in columns, one per workflow state.
                  </TabsContent>
                </Tabs>
                <ToggleGroup type="multiple" variant="outline" aria-label="Formatting">
                  <ToggleGroupItem value="bold" aria-label="Bold">
                    <Bold />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="italic" aria-label="Italic">
                    <Italic />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="underline" aria-label="Underline">
                    <Underline />
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </Demo>
          </Section>

          <Section
            id="overlays"
            title="Overlays"
            description="Dialogs, menus, popovers, tooltips and toasts — all keyboard accessible."
          >
            <Demo>
              <div className="flex flex-wrap items-center gap-2">
                <Dialog>
                  <DialogTrigger asChild>
                    <Button variant="outline">Open dialog</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Delete task?</DialogTitle>
                      <DialogDescription>
                        &ldquo;Sponsor the regional trade fair&rdquo; will be moved to trash. You can restore
                        it for 30 days.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button variant="outline">Cancel</Button>
                      </DialogClose>
                      <DialogClose asChild>
                        <Button variant="destructive">Delete</Button>
                      </DialogClose>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline">Dropdown menu</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-48">
                    <DropdownMenuLabel>Task</DropdownMenuLabel>
                    <DropdownMenuItem>
                      Assign to me <DropdownMenuShortcut>I</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuItem>
                      Copy link <DropdownMenuShortcut>⌘L</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline">Popover</Button>
                  </PopoverTrigger>
                  <PopoverContent className="flex flex-col gap-2 text-sm">
                    <p className="font-medium">Set status</p>
                    {workflowStateTypes.map((t) => (
                      <button
                        key={t}
                        className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted"
                      >
                        <StatusIcon type={t} /> {cap(t)}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline">Tooltip</Button>
                  </TooltipTrigger>
                  <TooltipContent>Copy task link</TooltipContent>
                </Tooltip>
                <Button
                  variant="outline"
                  onClick={() =>
                    toast.success("Task created", { description: "Book venue for the team offsite" })
                  }
                >
                  Show toast
                </Button>
              </div>
            </Demo>
          </Section>

          <Section id="feedback" title="Feedback">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Inbox />
                    </EmptyMedia>
                    <EmptyTitle>You&apos;re all caught up</EmptyTitle>
                    <EmptyDescription>New tasks assigned to you will appear here.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button size="sm">
                      <Plus /> Create task
                    </Button>
                  </EmptyContent>
                </Empty>
              </Card>
              <div className="flex flex-col gap-4">
                <Alert>
                  <Terminal />
                  <AlertTitle>Calendar connected</AlertTitle>
                  <AlertDescription>Meetings now sync with your Google Calendar.</AlertDescription>
                </Alert>
                <Alert variant="destructive">
                  <Terminal />
                  <AlertTitle>Couldn&apos;t save your changes</AlertTitle>
                  <AlertDescription>Check your connection. Retrying in 5 seconds.</AlertDescription>
                </Alert>
                <Card>
                  <CardContent className="flex items-center gap-3">
                    <Skeleton className="size-10 rounded-full" />
                    <div className="flex flex-1 flex-col gap-2">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-4 w-1/2" />
                    </div>
                    <Spinner />
                  </CardContent>
                </Card>
              </div>
            </div>
          </Section>

          <Section
            id="attachments"
            title="Attachments"
            description="Task attachments: AttachmentRow for stored files (images get a thumbnail) and UploadRow while uploading or after a failure. Images in documents and covers render with AttachmentImage, which shows a placeholder when the file is gone."
          >
            <Demo>
              <ul className="flex w-full max-w-md flex-col gap-1">
                <AttachmentRow
                  filename="Q3 roadmap.pdf"
                  meta="1.2 MB · Ada Park · 2h ago"
                  openHref="#attachments"
                  downloadHref="#attachments"
                  onDelete={() => toast("Deleted Q3 roadmap.pdf")}
                />
                <UploadRow name="screenshot.png" progress={0.62} />
                <UploadRow
                  name="recording.mov"
                  progress={0}
                  error="Files can be at most 10 MB"
                  onDismiss={() => toast("Dismissed")}
                />
              </ul>
            </Demo>
            <Demo>
              <div className="flex w-full max-w-md flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  RecordAttachments (on module records: certificates, specifications, photos, reply letters)
                  is this row list plus a kind picker and an Attach button. It needs the workspace and API, so
                  it is shown here as its parts. A signed-off record keeps its files and says so.
                </p>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    Attachments <span className="ml-1 tabular-nums">2</span>
                  </h3>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Lock className="size-3" /> Signed off: files can be added but not removed
                  </span>
                </div>
                <ul className="flex flex-col gap-1">
                  <AttachmentRow
                    filename="BRCGS certificate 2026.pdf"
                    meta="Certificate · 640 KB · Ada Park · 3d ago"
                    openHref="#attachments"
                    downloadHref="#attachments"
                  />
                  <AttachmentRow
                    filename="Spec sheet rev 4.pdf"
                    meta="Specification · 210 KB · Marcus Bell · 1d ago"
                    openHref="#attachments"
                    downloadHref="#attachments"
                  />
                </ul>
              </div>
            </Demo>
          </Section>

          <Section
            id="assistant"
            title="Assistant"
            description="AssistantMessageView: one message in the assistant sidebar (⌘J). The person's prompt is a bubble; the agent's reply renders a small Markdown subset (as React, never HTML) with each tool call collapsed to one line, plus its running, stopped or failed state."
          >
            <Demo>
              <div className="flex w-full max-w-sm flex-col gap-5 rounded-xl border p-4">
                <AssistantMessageView
                  message={{
                    role: "user",
                    text: "What's due this week?",
                    parts: [],
                    status: "done",
                    error: null,
                  }}
                />
                <AssistantMessageView
                  message={{
                    role: "assistant",
                    text: null,
                    status: "done",
                    error: null,
                    parts: [
                      {
                        type: "tool",
                        id: "t1",
                        name: "mcp__knotworking__list_tasks",
                        input: '{"workspace":"acme","due":"this-week"}',
                        status: "done",
                        output: "2 tasks",
                      },
                      {
                        type: "text",
                        text: "Two tasks are due:\n- **Fix the oven seal** (Fri)\n- Order `flour` for batch 12 (Thu)",
                      },
                    ],
                  }}
                />
                <AssistantMessageView
                  message={{
                    role: "assistant",
                    text: null,
                    status: "running",
                    error: null,
                    parts: [
                      {
                        type: "tool",
                        id: "t2",
                        name: "mcp__knotworking__create_task",
                        input: "{}",
                        status: "running",
                      },
                    ],
                  }}
                />
                <AssistantMessageView
                  message={{
                    role: "assistant",
                    text: null,
                    status: "error",
                    error: "Claude rejected your API key. Update it under Settings → Assistant.",
                    parts: [],
                  }}
                />
              </div>
            </Demo>
          </Section>

          <Section
            id="editor"
            title="Editor"
            description="DocEditor: Tiptap over the stored block JSON, for docs and task descriptions. Type '/' for blocks, select text to format, or use Markdown shortcuts (#, -, [ ], >, ```). Mentions (@) render as chips; the picker needs a workspace, so it is not offered here."
          >
            <EditorDemo />
          </Section>

          <Section
            id="print"
            title="Print & export"
            description="The print-ready pages (product label, purchase order, audit records) use PrintPage: an A4 sheet on screen, and on paper only the sheet, black on white, with the app's sidebar and header hidden (rules in globals.css). Below: the heading, the notices a draft label or a failed record carries, the audit record list with a correction, the date range form and the CSV button. Open a label, order or audit record and use Print to see a whole page."
          >
            <div className="print-sheet flex flex-col gap-4 rounded-md p-6 ring-1 ring-border">
              <PrintHeading
                workspace="Acme Bakery"
                title="HACCP monitoring record"
                subtitle="HP-001 Bakery · plan v2 · 14 Oct 2026 to 12 Nov 2026"
              />
              <PrintNotice strong>{labelPrintState({ status: "draft", stale: false }).banner}</PrintNotice>
              <PrintNotice>2 mock recall tests in this range failed.</PrintNotice>
              <AuditRecordList
                title="CCP checks"
                description="Oldest first. A corrected reading stays on the record, struck through."
                entries={demoAuditEntries}
              />
              <div className="mt-4 flex flex-wrap gap-6">
                <SignatureLine label="Checked by" name="Ada Park" at="12 Nov 2026" />
                <SignatureLine label="Signed off by" />
              </div>
            </div>
            <Demo>
              <div className="flex flex-wrap items-start gap-6">
                <LotBarcode lotCode="L261113001" format="code128" />
                <LotBarcode
                  lotCode="L261113001"
                  expiresOn="2026-12-31"
                  expiryType="use_by"
                  format="gs1-128"
                />
              </div>
            </Demo>
            <Demo>
              <div className="flex flex-col gap-4">
                <DateRangeForm range={{ from: "2026-10-14", to: "2026-11-12" }} />
                <div>
                  <ExportCsvButton
                    name="Demo records"
                    rows={[
                      ["Checked at", "Reading", "Note"],
                      ["2026-11-12T09:00:00.000Z", 78, "=1+1 stays text in the file"],
                    ]}
                  />
                </div>
              </div>
            </Demo>
          </Section>
        </div>
      </main>
    </div>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-8 flex-col gap-6">
      <div className="flex flex-col gap-1 border-b pb-4">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function ApiAccessDemo() {
  const [on, setOn] = useState(true);
  const base = {
    id: "stock.waste",
    label: "Record waste",
    description: "Tokens may write off stock as waste, for example from a waste scale.",
    level: "write" as const,
    enabledBy: "Ada Park",
    enabledAt: "2026-11-12T12:40:00Z",
  };
  return (
    <Demo>
      <div className="flex flex-col gap-4">
        <Card className="divide-y py-0">
          <TokenActionRow action={{ ...base, enabled: on }} canManage onToggle={setOn} />
          <TokenActionRow
            action={{
              ...base,
              id: "stock.adjust",
              label: "Post stock adjustments",
              level: "manage",
              enabled: false,
              enabledBy: null,
              enabledAt: null,
            }}
            canManage={false}
            onToggle={() => {}}
          />
        </Card>
        <div className="flex gap-2">
          <ResultBadge status={201} />
          <ResultBadge status={400} />
          <ResultBadge status={409} />
          <ResultBadge status={403} />
        </div>
      </div>
    </Demo>
  );
}

const demoAuditEntries: AuditEntry[] = [
  {
    id: "a1",
    at: "2026-11-10T09:00:00.000Z",
    atText: "10 Nov 2026, 09:00 UTC",
    title: "CCP1 Cook",
    lines: ["Limit: at least 75 °C", "Batch B-0412"],
    result: "58 °C, OUT OF LIMITS",
    problem: true,
    doneBy: "Checked by Marcus Chen",
    note: null,
    corrects: null,
    replaced: true,
    signOff: "Approved by Ada Park, 10 Nov 2026, 10:00 UTC",
    followUps: [],
    summary: "10 Nov 2026, 09:00 UTC: CCP1 58 °C",
  },
  {
    id: "a2",
    at: "2026-11-10T09:05:00.000Z",
    atText: "10 Nov 2026, 09:05 UTC",
    title: "CCP1 Cook",
    lines: ["Limit: at least 75 °C", "Batch B-0412"],
    result: "78 °C, within limits",
    problem: false,
    doneBy: "Checked by Marcus Chen",
    note: null,
    corrects: { summary: "10 Nov 2026, 09:00 UTC: CCP1 58 °C", reason: "Probe was not in the core" },
    replaced: false,
    signOff: "Approved by Ada Park, 10 Nov 2026, 10:00 UTC",
    followUps: [],
    summary: "10 Nov 2026, 09:05 UTC: CCP1 78 °C",
  },
];

function Demo({ children }: { children: ReactNode }) {
  return (
    <Card>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Swatch classes are listed in full so Tailwind's scanner can see them. */
function Swatches({ title, items }: { title: string; items: [string, string][] }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {items.map(([name, cls]) => (
          <div key={name} className="flex flex-col gap-1.5">
            <div className={`h-12 rounded-lg ring-1 ring-foreground/10 ${cls}`} />
            <code className="truncate font-mono text-xs text-muted-foreground">{name}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

const demoLabels = [
  ["client", "Client request", "red"],
  ["content", "Content", "purple"],
  ["event", "Event", "pink"],
  ["finance", "Finance", "green"],
] as const;

/** A product label as the labels module drafts it (static: nothing is computed or saved). */
const demoLabel: LabelPreviewContent = {
  productName: "All-butter shortbread",
  netQuantity: "150 g",
  ingredients: parseSegmentsMarkup(
    "**Wheat** flour (**wheat** flour, calcium carbonate, iron, niacin, thiamin), **Butter** (31%), Sugar, Rice flour",
  ),
  allergenStatement: "Allergy advice: for allergens, see ingredients in bold. May contain tree nuts.",
  includeNutrition: true,
  nutrition: nutritionPanel("100g", {
    energyKj: 2190.6,
    energyKcal: 523.4,
    fat: 28.31,
    saturates: 17.72,
    carbohydrate: 61.9,
    sugars: 19.4,
    fibre: 1.84,
    protein: 5.62,
    salt: 0.384,
  }),
  storageInstructions: "Store in a cool, dry place.",
  dateGuidance: "Best before: see date on pack.",
  gtin: "5901234123457",
};

/** Used when naming labels, teams and projects (settings → Labels, Teams). */
/** The CCP check and correction dialogs, with the API call replaced: nothing is recorded. */
function HaccpFormsDemo() {
  const [open, setOpen] = useState<"range" | "pass_fail" | "correct" | "sheet" | null>(null);
  const demo = async () => "Demo only: nothing was recorded";
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => setOpen("range")}>
        Record a check (measured)
      </Button>
      <Button variant="outline" onClick={() => setOpen("pass_fail")}>
        Record a check (pass or fail)
      </Button>
      <Button variant="outline" onClick={() => setOpen("correct")}>
        Correct a reading
      </Button>
      <Button variant="outline" onClick={() => setOpen("sheet")}>
        Check sheet (several readings)
      </Button>
      {open === "sheet" && (
        <CheckSheetDialog
          slug="acme"
          rows={[
            { key: "baking", planCode: "HACCP-01", ccp: demoCcps.baking, batch: null },
            {
              key: "metal",
              planCode: "HACCP-01",
              ccp: demoCcps.metal,
              batch: { id: "batch-demo", batchCode: "B261110-3" },
            },
          ]}
          onClose={() => setOpen(null)}
          onRecord={async () => "Demo only: nothing was recorded"}
        />
      )}
      {(open === "range" || open === "pass_fail") && (
        <CcpCheckDialog
          slug="acme"
          planCode="HACCP-01"
          ccp={open === "range" ? demoCcps.baking : demoCcps.metal}
          batches={[{ id: "batch-demo", batchCode: "B261110-3" }]}
          onClose={() => setOpen(null)}
          onRecord={demo}
        />
      )}
      {open === "correct" && (
        <CorrectReadingDialog
          slug="acme"
          log={{ id: "log-1", readingText: "68 °C", ccpCode: "CCP1" }}
          ccp={demoCcps.baking}
          onClose={() => setOpen(null)}
          onRecord={demo}
        />
      )}
    </div>
  );
}

function ModuleAccessDemo() {
  const [members, setMembers] = useState<ModuleAccessMember[]>([
    { userId: "1", name: "Ada Park", role: "owner", locked: true, access: {} },
    {
      userId: "2",
      name: "Marcus Chen",
      role: "member",
      locked: false,
      access: {
        tasks: { grant: null, effective: "write" },
        docs: { grant: "read", effective: "read" },
        time: { grant: "none", effective: "none" },
      },
    },
    {
      userId: "3",
      name: "Noor Haddad",
      role: "guest",
      locked: false,
      access: {
        tasks: { grant: "none", effective: "none" },
        docs: { grant: null, effective: "read" },
        time: { grant: null, effective: "none" },
      },
    },
  ]);
  return (
    <ModuleAccessTable
      modules={[
        { id: "tasks", name: "Tasks and projects", description: "Tasks, states, labels and projects." },
        { id: "docs", name: "Documents", description: "The team wiki." },
        { id: "time", name: "Time tracking", description: "Logged time and reports. Needs tasks." },
      ]}
      members={members}
      onChange={(userId, moduleId, level) =>
        setMembers((all) =>
          all.map((m) =>
            m.userId === userId
              ? {
                  ...m,
                  access: {
                    ...m.access,
                    [moduleId]: { grant: level, effective: level ?? (m.role === "guest" ? "read" : "write") },
                  },
                }
              : m,
          ),
        )
      }
    />
  );
}

function TimeDemo() {
  const [since, setSince] = useState<string | null>(null);
  const [hourAgo] = useState(() => new Date(Date.now() - 65 * 60_000).toISOString());
  return (
    <Demo>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-6">
          <TimeSummary logged={90} estimate={240} />
          <TimeSummary logged={300} estimate={240} />
          <TimeSummary logged={45} />
          <TimeSummary logged={90} estimate={240} compact />
        </div>
        <div className="flex items-center gap-3">
          <TimerButton
            runningSince={since}
            onStart={() => setSince(new Date().toISOString())}
            onStop={() => setSince(null)}
          />
          <TimerButton runningSince={hourAgo} onStart={() => {}} onStop={() => {}} />
        </div>
        <TimeEntryForm
          submitLabel="Log time"
          onSubmit={async ({ minutes, entryDate }) => {
            toast.success(`Logged ${minutes} minutes on ${entryDate}`);
            return true;
          }}
        />
      </div>
    </Demo>
  );
}

/** Sample tasks around today, rescheduled in local state. */
function TimelineDemo() {
  const [today] = useState(() => localIsoDate());
  const at = (offset: number) => fromDay(toDay(today)! + offset);
  const [tasks, setTasks] = useState<GanttTask[]>(() => {
    const person = (name: string) => ({ name, avatarUrl: null });
    const t = (id: string, title: string, rest: Partial<GanttTask>): GanttTask => ({
      id,
      title,
      parentId: null,
      startDate: null,
      dueDate: null,
      sortOrder: id,
      status: "unstarted",
      ...rest,
    });
    return [
      t("a", "Brief and moodboard", {
        startDate: at(-12),
        dueDate: at(-7),
        status: "completed",
        assignee: person("Priya Raman"),
      }),
      t("b", "Venue shortlist", {
        startDate: at(-6),
        dueDate: at(-1),
        status: "started",
        statusProgress: 0.5,
        assignee: person("Marcus Chen"),
      }),
      t("c", "Site visits", { parentId: "b", startDate: at(-3), dueDate: at(-2), status: "completed" }),
      t("d", "Budget sign-off", { dueDate: at(-2), status: "unstarted", assignee: person("Ada Park") }),
      t("e", "Supplier contracts", {
        startDate: at(-2),
        dueDate: at(6),
        status: "started",
        statusProgress: 0.75,
        assignee: person("Noor Haddad"),
      }),
      t("f", "Run of show", { startDate: at(7), dueDate: at(12), status: "backlog" }),
      t("g", "Event day", { dueDate: at(14), status: "unstarted" }),
      t("h", "Thank-you notes", { status: "backlog" }),
    ];
  });
  const relations = [
    { id: "r1", blockingTaskId: "a", blockedTaskId: "b" },
    { id: "r2", blockingTaskId: "b", blockedTaskId: "e" },
    { id: "r3", blockingTaskId: "e", blockedTaskId: "f" },
    { id: "r4", blockingTaskId: "f", blockedTaskId: "g" },
  ];
  return (
    <Card className="overflow-hidden py-0">
      <GanttChart
        tasks={tasks}
        relations={relations}
        project={{ startDate: at(-14), targetDate: at(15) }}
        today={today}
        canEdit
        onReschedule={(id, patch) =>
          setTasks((all) => all.map((x) => (x.id === id ? { ...x, ...patch } : x)))
        }
        onOpen={(task) => toast(task.title)}
      />
    </Card>
  );
}

const reportOptions = {
  projects: [
    { id: "p1", name: "Website relaunch" },
    { id: "p2", name: "Mobile app" },
  ],
  teams: [
    { id: "t1", name: "Engineering" },
    { id: "t2", name: "Design" },
  ],
  people: people.map((name) => ({ id: name, name })),
};

function TimeReportDemo() {
  const [filters, setFilters] = useState<ReportFilters>(() => ({
    preset: "this-week",
    ...presetRange("this-week", new Date(), "Europe/London"),
    groupBy: "project",
  }));
  return (
    <Demo>
      <div className="flex flex-col gap-6">
        <TimeReportFilters filters={filters} options={reportOptions} onChange={setFilters} exportHref="#" />
        <div className="rounded-lg border">
          <TimeReportTable
            groupLabel="Project"
            totals={{
              loggedMinutes: 1275,
              entryCount: 14,
              estimateMinutes: 1080,
              loggedOnEstimatedMinutes: 1215,
            }}
            rows={[
              {
                id: "a",
                label: "Website relaunch",
                loggedMinutes: 735,
                entryCount: 8,
                estimateMinutes: 600,
                loggedOnEstimatedMinutes: 735,
              },
              {
                id: "b",
                label: "Mobile app",
                loggedMinutes: 480,
                entryCount: 5,
                estimateMinutes: 480,
                loggedOnEstimatedMinutes: 480,
              },
              {
                id: "c",
                label: "Handbook",
                loggedMinutes: 120,
                entryCount: 3,
                estimateMinutes: 300,
                loggedOnEstimatedMinutes: 60,
              },
              {
                id: "d",
                label: "No project",
                loggedMinutes: 60,
                entryCount: 1,
                estimateMinutes: null,
                loggedOnEstimatedMinutes: 0,
              },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-6 text-sm">
          <EstimateVariance logged={135} estimate={120} />
          <EstimateVariance logged={30} estimate={120} />
          <EstimateVariance logged={60} estimate={60} />
          <EstimateVariance logged={45} estimate={null} />
        </div>
      </div>
    </Demo>
  );
}

function ColorPickerDemo() {
  const [color, setColor] = useState<TagColorName>("teal");
  return (
    <div className="flex flex-wrap items-center gap-4">
      <ColorPicker value={color} onValueChange={setColor} aria-label="Label color" />
      <LabelBadge color={color}>Selected: {color}</LabelBadge>
      <LabelBadge color={color} variant="tint">
        {cap(color)}
      </LabelBadge>
    </div>
  );
}

function PropertyMenuDemo() {
  const [status, setStatus] = useState<string>("unstarted");
  const [priority, setPriority] = useState<Priority>(2);
  const [assignee, setAssignee] = useState<string | null>(people[0]!);
  const [labels, setLabels] = useState<string[]>(["content"]);
  const chip =
    "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-sm hover:bg-muted data-[state=open]:bg-muted";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <PropertyMenu
        options={workflowStateTypes.map((t, i) => ({
          value: t,
          label: cap(t),
          icon: <StatusIcon type={t} />,
          shortcut: String(i + 1),
        }))}
        value={status}
        onValueChange={setStatus}
        placeholder="Change status…"
      >
        <button type="button" className={chip}>
          <StatusIcon type={status as (typeof workflowStateTypes)[number]} /> {cap(status)}
        </button>
      </PropertyMenu>
      <PropertyMenu
        options={([0, 1, 2, 3, 4] as Priority[]).map((p) => ({
          value: String(p),
          label: priorityLabels[p],
          icon: <PriorityIcon priority={p} />,
          shortcut: String(p),
        }))}
        value={String(priority)}
        onValueChange={(v) => setPriority(Number(v) as Priority)}
        placeholder="Set priority…"
      >
        <button type="button" className={chip}>
          <PriorityIcon priority={priority} /> {priorityLabels[priority]}
        </button>
      </PropertyMenu>
      <PropertyMenu
        options={[
          { value: "none", label: "No assignee", shortcut: "0" },
          ...people.map((p) => ({ value: p, label: p, icon: <UserAvatar name={p} className="size-5" /> })),
        ]}
        value={assignee ?? "none"}
        onValueChange={(v) => setAssignee(v === "none" ? null : v)}
        placeholder="Assign to…"
      >
        <button type="button" className={chip}>
          {assignee ? <UserAvatar name={assignee} className="size-5" /> : null} {assignee ?? "Assignee"}
        </button>
      </PropertyMenu>
      <PropertyMenu
        multiple
        options={demoLabels.map(([value, label, color]) => ({
          value,
          label,
          icon: <ColorDot color={color} className="size-2.5" />,
        }))}
        value={labels}
        onValueChange={setLabels}
        placeholder="Add labels…"
      >
        <button type="button" className={chip}>
          {labels.length
            ? demoLabels
                .filter(([v]) => labels.includes(v))
                .map(([v, label, color]) => (
                  <LabelBadge key={v} color={color}>
                    {label}
                  </LabelBadge>
                ))
            : "Labels"}
        </button>
      </PropertyMenu>
    </div>
  );
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

const editorSample: DocContent = d.doc(
  d.h(2, "Offsite plan"),
  d.p(
    "Two days in the mountains. ",
    d.text("Bring layers", "bold"),
    " and something to ",
    d.text("share", "highlight"),
    ".",
  ),
  d.tasks(["Book the venue", true], ["Send the agenda", false]),
  d.callout("💡", "Select text to see the formatting toolbar."),
  d.bullets("Day 1: strategy", "Day 2: hiking and retro"),
  d.table([
    ["Day", "Focus", "Owner"],
    ["1", "Strategy", "Ada"],
    ["2", "Hiking and retro", "Marcus"],
  ]),
  d.callout("↹", "Click in the table for row and column controls; Tab moves between cells."),
  // Chips link to pages and resolve live names inside a workspace; here they show the cached label.
  d.p(
    "Owner ",
    d.mention("user", "00000000-0000-4000-8000-000000000001", "Ada Park"),
    ", see ",
    d.mention("doc", "00000000-0000-4000-8000-000000000002", "Offsite budget"),
    " and ",
    d.mention("task", "00000000-0000-4000-8000-000000000003", "Book the venue"),
    ". Type @ to mention people, tasks and pages in a workspace.",
  ),
);

/** Autosave against a fake request, so the status indicator can be seen. */
function EditorDemo() {
  const [editable, setEditable] = useState(true);
  const [json, setJson] = useState<DocContent>(editorSample);
  const { status, schedule } = useAutosave<{ content: DocContent }>(
    async ({ content }) => {
      await new Promise((r) => setTimeout(r, 400));
      setJson(content);
    },
    { delay: 600 },
  );
  return (
    <Demo>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Switch id="editor-editable" checked={editable} onCheckedChange={setEditable} />
          <Label htmlFor="editor-editable">Editable (guests see it read-only)</Label>
          <SaveStatusText status={status} className="ml-auto" />
        </div>
        <Separator />
        <DocEditor
          key={String(editable)}
          content={json}
          editable={editable}
          onChange={(content) => schedule({ content })}
        />
      </div>
    </Demo>
  );
}
