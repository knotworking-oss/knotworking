import type { ModuleAccessLevel, ModuleId } from "@knotworking/core";
import {
  BookOpen,
  Boxes,
  Bug,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CircleDot,
  Clock,
  Clock8,
  ClipboardCheck,
  ClipboardList,
  Coins,
  CookingPot,
  Factory,
  Fence,
  FileCheck,
  FileText,
  FlaskConical,
  FolderKanban,
  GraduationCap,
  IdCard,
  Landmark,
  LayoutDashboard,
  LayoutGrid,
  Network,
  Package,
  PackagePlus,
  ShieldCheck,
  ShoppingCart,
  Tag,
  TrendingUp,
  Truck,
  Users,
  UsersRound,
  Warehouse,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/**
 * Sidebar navigation
 * ------------------
 * The sidebar shows one **area** at a time (picked from the workspace menu at the top, or from ⌘K).
 * An area is a module's section of the app, or the always-available "workspace" area for the
 * platform pages. Every item says what the viewer needs to see it, so a section never lists a
 * page that would 404 for them.
 *
 * Keep the hrefs in step with `apps/web/src/app/[workspace]/` and the access each layout asks for.
 */

/** What the viewer can do, as `useWorkspace()` reports it. */
export interface NavAccess {
  /** Whether the viewer has `level` (default `read`) in an active module. */
  can: (moduleId: ModuleId, level?: ModuleAccessLevel) => boolean;
  /** Not a guest. */
  canEdit: boolean;
  /** Whether a module is active in this environment, whatever the viewer's own level. */
  isActive: (moduleId: ModuleId) => boolean;
}

export type NavBadge = "myTasks";

export interface NavItem {
  label: string;
  /** Path under `/{slug}`, no leading slash. Empty is the area's own root. */
  path: string;
  icon?: LucideIcon;
  /** The sidebar tooltip, when the label alone is not enough. */
  tooltip?: string;
  /** Highlight only on this exact path (the section's overview, which other pages sit under). */
  exact?: boolean;
  /** Extra access needed on top of the area's own. */
  show?: (access: NavAccess) => boolean;
  badge?: NavBadge;
}

export interface NavSection {
  /** Shown above the items when set. */
  label?: string;
  items: NavItem[];
}

export interface NavArea {
  /** A module id, or "workspace". */
  id: ModuleId | "workspace";
  label: string;
  description: string;
  icon: LucideIcon;
  /** Group heading in the area picker. */
  group: "Work" | "Operations" | "People" | "Workspace";
  /** Whether the viewer can open the area at all. */
  visible: (access: NavAccess) => boolean;
  sections: NavSection[];
  /** Extra words the area search matches. */
  keywords?: string[];
}

const needs =
  (moduleId: ModuleId, level: ModuleAccessLevel = "read") =>
  (a: NavAccess) =>
    a.can(moduleId, level);

export const WORKSPACE_AREA = "workspace";

/**
 * Pages that are always in the sidebar, whichever module is showing: task planning and the
 * calendar are global tools, not something to switch to. (Teams are listed beside them from the
 * workspace's teams.)
 */
export const pinnedItems: readonly NavItem[] = [
  { label: "My tasks", path: "my-tasks", icon: CircleDot, badge: "myTasks", show: needs("tasks") },
  { label: "Projects", path: "projects", icon: FolderKanban, show: needs("tasks") },
  { label: "Calendar", path: "calendar", icon: CalendarDays, show: needs("calendar") },
];

/** The company wiki (the docs module): linked under every module, with the recently opened docs. */
export const wikiItem: NavItem = {
  label: "Wiki",
  path: "docs",
  icon: BookOpen,
  tooltip: "Company wiki",
  exact: true,
  show: needs("docs"),
};

/** The always-present items the viewer can see. */
export const visiblePinned = (access: NavAccess): NavItem[] =>
  pinnedItems.filter((i) => !i.show || i.show(access));

/** Roots of the pinned pages (and their detail pages): they belong to no module. */
export const globalRoots: readonly string[] = [
  ...pinnedItems.map((i) => i.path.split("/")[0] ?? ""),
  wikiItem.path,
  "task",
  "team",
  "inbox",
];

export const navAreas: readonly NavArea[] = [
  {
    id: "bi",
    label: "Dashboards",
    description: "Dashboards and board reporting",
    icon: LayoutDashboard,
    group: "Work",
    visible: needs("bi"),
    keywords: ["reports", "charts", "kpi", "bi"],
    sections: [{ items: [{ label: "Dashboards", path: "dashboards", icon: LayoutDashboard }] }],
  },
  {
    id: "time",
    label: "Time",
    description: "Timers and time reports",
    icon: Clock,
    group: "Work",
    visible: needs("time"),
    keywords: ["timesheet", "timer"],
    sections: [{ items: [{ label: "Time reports", path: "time", icon: Clock }] }],
  },

  {
    id: "items",
    label: "Items & suppliers",
    description: "Ingredients, packaging and products",
    icon: Package,
    group: "Operations",
    visible: needs("items"),
    keywords: ["ingredients", "packaging", "products", "master data"],
    sections: [
      {
        items: [
          { label: "Items", path: "items", icon: Package },
          { label: "Suppliers", path: "suppliers", icon: Truck },
        ],
      },
    ],
  },
  {
    id: "recipes",
    label: "Recipes",
    description: "Bills of materials and approvals",
    icon: CookingPot,
    group: "Operations",
    visible: needs("recipes"),
    keywords: ["bom", "formulation"],
    sections: [{ items: [{ label: "Recipes", path: "recipes", icon: CookingPot }] }],
  },
  {
    id: "labels",
    label: "Labels & nutrition",
    description: "Product labels and ingredient nutrition",
    icon: Tag,
    group: "Operations",
    visible: needs("labels"),
    keywords: ["nutrition", "allergens"],
    sections: [
      {
        items: [
          { label: "Product labels", path: "labels", icon: Tag, exact: true },
          { label: "Ingredient nutrition", path: "labels/nutrition", icon: FlaskConical },
        ],
      },
    ],
  },
  {
    id: "specifications",
    label: "Specifications",
    description: "Product and ingredient specifications",
    icon: FileCheck,
    group: "Operations",
    visible: needs("specifications"),
    sections: [{ items: [{ label: "Specifications", path: "specifications", icon: FileCheck }] }],
  },
  {
    id: "testing",
    label: "Testing",
    description: "Lab and in-house test programmes",
    icon: FlaskConical,
    group: "Operations",
    visible: needs("testing"),
    keywords: ["lab", "micro"],
    sections: [
      {
        items: [
          { label: "Results", path: "testing", icon: FlaskConical, exact: true },
          { label: "Due", path: "testing/due", icon: CalendarClock },
          { label: "Trends", path: "testing/trends", icon: TrendingUp },
          { label: "Setup", path: "testing/setup", icon: ClipboardList },
        ],
      },
    ],
  },
  {
    id: "npd",
    label: "Product development",
    description: "New product development projects",
    icon: PackagePlus,
    group: "Operations",
    visible: needs("npd"),
    keywords: ["npd", "trials"],
    sections: [{ items: [{ label: "Product development", path: "npd", icon: PackagePlus }] }],
  },
  {
    id: "stock",
    label: "Stock",
    description: "Lots, locations and adjustments",
    icon: Warehouse,
    group: "Operations",
    visible: needs("stock"),
    keywords: ["inventory", "warehouse", "lots"],
    sections: [
      {
        items: [
          { label: "Stock", path: "stock", icon: Warehouse, exact: true },
          { label: "Locations", path: "stock/locations", icon: LayoutGrid },
          { label: "Release rules", path: "stock/release-rules", icon: ShieldCheck },
        ],
      },
    ],
  },
  {
    id: "customers",
    label: "Customers",
    description: "Customer records",
    icon: Users,
    group: "Operations",
    visible: needs("customers"),
    sections: [{ items: [{ label: "Customers", path: "customers", icon: Users }] }],
  },
  {
    id: "sales",
    label: "Sales",
    description: "Sales orders, prices and commitments",
    icon: ShoppingCart,
    group: "Operations",
    visible: needs("sales"),
    keywords: ["orders"],
    sections: [
      {
        items: [
          { label: "Sales orders", path: "sales", icon: ShoppingCart, exact: true },
          { label: "Prices", path: "sales/prices", icon: Coins },
          { label: "Commitments", path: "sales/commitments", icon: ClipboardList },
          { label: "Integration", path: "sales/integration", icon: Network },
        ],
      },
    ],
  },
  {
    id: "client_services",
    label: "Client services",
    description: "Service quotes, delivery and billing drafts",
    icon: FileCheck,
    group: "Operations",
    visible: needs("client_services"),
    keywords: ["service", "quote", "hourly", "billing", "consulting"],
    sections: [{ items: [{ label: "Service quotes", path: "client-services", icon: FileCheck }] }],
  },
  {
    id: "despatch",
    label: "Despatch",
    description: "Despatches, recipients and impact",
    icon: Truck,
    group: "Operations",
    visible: needs("despatch"),
    keywords: ["shipping", "delivery"],
    sections: [
      {
        items: [
          { label: "Despatch", path: "despatch", icon: Truck, exact: true },
          { label: "Recipients", path: "despatch/recipients", icon: Users },
          {
            label: "Impact",
            path: "despatch/impact",
            icon: Network,
            show: needs("production"),
          },
        ],
      },
    ],
  },
  {
    id: "invoicing",
    label: "Invoicing",
    description: "Customer invoices and credit notes",
    icon: FileText,
    group: "Operations",
    visible: needs("invoicing"),
    keywords: ["customer", "billing", "credit notes", "sales invoices"],
    sections: [{ items: [{ label: "Customer invoices and credits", path: "invoicing", icon: FileText }] }],
  },
  {
    id: "purchasing",
    label: "Purchasing",
    description: "Purchase orders, invoices and prices",
    icon: ShoppingCart,
    group: "Operations",
    visible: needs("purchasing"),
    keywords: ["orders", "invoices", "suppliers"],
    sections: [
      {
        items: [
          { label: "Orders", path: "purchasing", icon: ShoppingCart, exact: true },
          { label: "Invoices", path: "purchasing/invoices", icon: FileText },
          { label: "Credit notes", path: "purchasing/credit-notes", icon: FileText },
          { label: "Price lists", path: "purchasing/prices", icon: Coins },
          {
            label: "Suggestions",
            path: "purchasing/suggestions",
            icon: TrendingUp,
            // From production's shortfall: Production is a soft dependency of Purchasing.
            show: needs("production"),
          },
          { label: "Supplier performance", path: "purchasing/suppliers", icon: Truck },
        ],
      },
    ],
  },
  {
    id: "assets",
    label: "Assets",
    description: "Areas, equipment, vehicles, IT and tools",
    icon: Boxes,
    group: "Operations",
    visible: needs("assets"),
    keywords: ["asset register", "equipment", "areas", "vehicles", "tools", "it"],
    sections: [{ items: [{ label: "Asset register", path: "assets", icon: Boxes }] }],
  },
  {
    id: "purchase_requests",
    label: "Purchase requests",
    description: "Spending requests and approvals",
    icon: ClipboardCheck,
    group: "Operations",
    visible: needs("purchase_requests"),
    keywords: ["spending", "approval", "expenses", "procurement"],
    sections: [{ items: [{ label: "Purchase requests", path: "purchase-requests", icon: ClipboardCheck }] }],
  },
  {
    id: "demand",
    label: "Demand planning",
    description: "Forecasts and cover",
    icon: TrendingUp,
    group: "Operations",
    visible: needs("demand"),
    keywords: ["forecast"],
    sections: [
      {
        items: [
          { label: "Demand", path: "demand", icon: TrendingUp, exact: true },
          { label: "Lines", path: "demand/lines", icon: ClipboardList },
          { label: "Cover", path: "demand/cover", icon: Warehouse },
        ],
      },
    ],
  },
  {
    id: "production",
    label: "Production",
    description: "Plans, schedules and work orders",
    icon: Factory,
    group: "Operations",
    visible: needs("production"),
    keywords: ["manufacturing", "work orders", "batches"],
    sections: [
      {
        items: [
          { label: "Production", path: "production", icon: Factory, exact: true },
          { label: "Plan", path: "production/plan", icon: CalendarRange, show: needs("demand") },
          { label: "Schedule", path: "production/schedule", icon: CalendarClock },
          { label: "Requirements", path: "production/requirements", icon: ClipboardList },
          { label: "Daily demand", path: "production/daily-demand", icon: TrendingUp },
          { label: "Lines", path: "production/lines", icon: Factory },
          { label: "Performance", path: "production/performance", icon: TrendingUp },
          { label: "Devices", path: "production/devices", icon: Network },
        ],
      },
    ],
  },
  {
    id: "costing",
    label: "Costing",
    description: "Standard against actual cost",
    icon: Coins,
    group: "Operations",
    visible: needs("costing"),
    sections: [
      {
        items: [
          { label: "Standard against actual", path: "costing", icon: Coins, exact: true },
          { label: "Batches", path: "costing/batches", icon: Factory },
          { label: "Stock valuation", path: "costing/valuation", icon: Warehouse },
          { label: "Rates and standard costs", path: "costing/setup", icon: ClipboardList },
        ],
      },
    ],
  },
  {
    id: "haccp",
    label: "Food safety",
    description: "HACCP plans and monitoring records",
    icon: ShieldCheck,
    group: "Operations",
    visible: needs("haccp"),
    keywords: ["haccp", "ccp", "hazard"],
    sections: [
      {
        items: [
          { label: "Today's checks", path: "haccp", icon: ClipboardCheck, exact: true },
          { label: "Review", path: "haccp/review", icon: ShieldCheck, show: needs("haccp", "manage") },
          { label: "HACCP plans", path: "haccp/plans", icon: ClipboardList },
          { label: "Hazard library", path: "haccp/library", icon: FlaskConical },
          { label: "Deviations", path: "haccp/deviations", icon: Bug },
          { label: "Cleaning & calibration", path: "haccp/records", icon: FileText },
        ],
      },
    ],
  },
  {
    id: "maintenance",
    label: "Maintenance",
    description: "Recurring work, maintenance records and work orders",
    icon: ClipboardList,
    group: "Operations",
    visible: needs("maintenance"),
    sections: [{ items: [{ label: "Maintenance", path: "maintenance", icon: ClipboardList }] }],
  },
  {
    id: "checklists",
    label: "Checklists",
    description: "Templates, scheduled checks and follow-up actions",
    icon: ClipboardCheck,
    group: "Operations",
    visible: needs("checklists"),
    sections: [{ items: [{ label: "Checklists", path: "checklists", icon: ClipboardCheck }] }],
  },
  {
    id: "site",
    label: "Site programmes",
    description: "Pest, glass, maintenance and storage checks",
    icon: Bug,
    group: "Operations",
    visible: needs("site"),
    keywords: ["pest", "glass", "maintenance"],
    sections: [
      {
        items: [
          { label: "What's due", path: "site", icon: Bug, exact: true },
          { label: "Pest control", path: "site/pest", icon: Bug },
          { label: "Glass", path: "site/glass", icon: ShieldCheck },
          { label: "Storage temperatures", path: "site/storage", icon: Warehouse },
          { label: "Pre-start checks", path: "site/checks", icon: ClipboardCheck, show: needs("checklists") },
          { label: "Audit records", path: "site/records", icon: FileText },
        ],
      },
    ],
  },
  {
    id: "quality",
    label: "Quality",
    description: "Complaints, non-conformances and audits",
    icon: ClipboardCheck,
    group: "Operations",
    visible: needs("quality"),
    keywords: ["complaints", "audits", "ncr", "recall"],
    sections: [
      {
        items: [
          { label: "Overview", path: "quality", icon: ClipboardCheck, exact: true },
          { label: "Complaints", path: "quality/complaints", icon: ClipboardList },
          { label: "Non-conformances", path: "quality/nonconformances", icon: Bug },
          { label: "Audits", path: "quality/audits", icon: FileCheck },
          { label: "Authenticity", path: "quality/authenticity", icon: ShieldCheck, show: needs("items") },
          { label: "Recall tests", path: "quality/recall-tests", icon: Truck, show: needs("stock") },
          {
            label: "Live cases",
            path: "quality/incidents",
            icon: Network,
            show: (a) => a.can("despatch") && a.can("production"),
          },
          { label: "Trends", path: "quality/trends", icon: TrendingUp, show: needs("items") },
          { label: "Audit records", path: "quality/records", icon: FileText },
        ],
      },
    ],
  },
  {
    id: "defence",
    label: "Food defence",
    description: "Threat assessments, controls and exercises",
    icon: Fence,
    group: "Operations",
    visible: needs("defence"),
    keywords: ["vaccp", "tacccp"],
    sections: [
      {
        items: [
          { label: "Food defence", path: "defence", icon: Fence, exact: true },
          { label: "Assessments", path: "defence/assessments", icon: ClipboardList },
          { label: "Controls", path: "defence/controls", icon: ShieldCheck },
          { label: "Exercises", path: "defence/exercises", icon: CalendarClock },
        ],
      },
    ],
  },
  {
    id: "governance",
    label: "Management review",
    description: "Standards, objectives, reviews and concerns",
    icon: Landmark,
    group: "Operations",
    visible: needs("governance"),
    keywords: ["standards", "objectives", "culture", "brcgs"],
    sections: [
      {
        items: [
          { label: "Management review", path: "governance", icon: Landmark, exact: true },
          { label: "Standards", path: "governance/standards", icon: FileCheck },
          { label: "Requirements", path: "governance/requirements", icon: ClipboardList },
          { label: "Objectives", path: "governance/objectives", icon: TrendingUp },
          { label: "Reviews", path: "governance/reviews", icon: CalendarClock },
          { label: "Culture", path: "governance/culture", icon: Users },
          {
            label: "Concerns inbox",
            path: "governance/concerns",
            icon: ShieldCheck,
            show: needs("governance", "manage"),
          },
        ],
      },
    ],
  },
  {
    id: "hse",
    label: "Health, safety & environment",
    description: "Assessments, permits, incidents and inspections",
    icon: ShieldCheck,
    group: "Operations",
    visible: needs("hse"),
    keywords: ["hse", "coshh", "permits", "accidents"],
    sections: [
      {
        items: [
          { label: "Health, safety & environment", path: "hse", icon: ShieldCheck, exact: true },
          { label: "Permits", path: "hse/permits", icon: FileCheck, show: needs("assets") },
          {
            label: "Incidents",
            path: "hse/incidents",
            icon: Bug,
            show: needs("hse_incidents"),
          },
        ],
      },
    ],
  },
  {
    id: "sops",
    label: "SOPs",
    description: "Standard operating procedures",
    icon: ClipboardList,
    group: "Operations",
    visible: needs("sops"),
    keywords: ["procedures"],
    sections: [
      {
        items: [
          { label: "SOPs", path: "sops", icon: ClipboardList, exact: true },
          { label: "Outstanding", path: "sops/outstanding", icon: CalendarClock },
          { label: "Controlled copies", path: "sops/copies", icon: FileText },
        ],
      },
    ],
  },

  {
    id: "people",
    label: "People",
    description: "People records, leave, rota and staffing",
    icon: IdCard,
    group: "People",
    visible: needs("people"),
    keywords: ["hr", "staff", "leave", "rota", "workforce"],
    sections: [
      {
        items: [
          { label: "People", path: "people", icon: IdCard },
          {
            label: "Leave & availability",
            path: "workforce",
            icon: CalendarDays,
            exact: true,
            show: needs("workforce"),
          },
          { label: "Rota", path: "workforce/rota", icon: CalendarRange, show: needs("workforce") },
          {
            label: "Staffing",
            path: "workforce/staffing",
            icon: UsersRound,
            show: needs("workforce"),
          },
          {
            label: "Private HR records",
            path: "workforce/hr",
            icon: IdCard,
            show: needs("workforce_hr"),
          },
        ],
      },
    ],
  },
  {
    id: "attendance",
    label: "Attendance",
    description: "Clocking, shifts and payroll",
    icon: Clock8,
    group: "People",
    visible: needs("attendance"),
    keywords: ["clock", "shifts", "payroll"],
    sections: [
      {
        items: [
          { label: "Attendance", path: "attendance", icon: Clock8, exact: true },
          { label: "Shifts", path: "attendance/shifts", icon: CalendarRange },
          { label: "Payroll", path: "attendance/payroll", icon: Coins },
          { label: "Settings", path: "attendance/settings", icon: ClipboardList },
        ],
      },
    ],
  },
  {
    id: "training",
    label: "Training",
    description: "Courses, due dates and sign-off",
    icon: GraduationCap,
    group: "People",
    visible: needs("training"),
    keywords: ["courses", "competence"],
    sections: [
      {
        items: [
          { label: "Training", path: "training", icon: GraduationCap, exact: true },
          { label: "Courses", path: "training/courses", icon: FileText },
          { label: "Due", path: "training/due", icon: CalendarClock },
          { label: "Sign-off", path: "training/sign-off", icon: ClipboardCheck },
        ],
      },
    ],
  },

  {
    id: WORKSPACE_AREA,
    label: "Workspace",
    description: "Members, teams and settings",
    icon: Users,
    group: "Workspace",
    visible: () => true,
    keywords: ["members", "org chart", "settings", "concerns", "teams", "workflows"],
    sections: [
      {
        items: [
          { label: "Members", path: "settings/members", icon: Users },
          { label: "Org chart", path: "org-chart", icon: Network, show: (a) => a.canEdit },
          { label: "Teams & workflows", path: "settings/teams", icon: Workflow },
          { label: "Task labels", path: "settings/labels", icon: Tag, show: needs("tasks") },
          {
            label: "Connected calendars",
            path: "settings/calendars",
            icon: CalendarClock,
            show: needs("calendar"),
          },
          {
            label: "Raise a concern",
            path: "concerns",
            icon: ShieldCheck,
            // Every member can raise a confidential concern while Management review is on.
            show: (a) => a.isActive("governance"),
          },
        ],
      },
    ],
  },
];

export const areaIds = navAreas.map((a) => a.id);
export type AreaId = (typeof navAreas)[number]["id"];

export const isAreaId = (value: string | undefined | null): value is AreaId =>
  !!value && (areaIds as readonly string[]).includes(value);

export const getArea = (id: string | undefined | null): NavArea | undefined =>
  navAreas.find((a) => a.id === id);

/** The areas the viewer can open, in menu order. */
export const visibleAreas = (access: NavAccess): NavArea[] => navAreas.filter((a) => a.visible(access));

/** An area's sections with the items the viewer can't see removed (and sections left empty dropped). */
export function visibleSections(area: NavArea, access: NavAccess): NavSection[] {
  return area.sections
    .map((s) => ({ ...s, items: s.items.filter((i) => !i.show || i.show(access)) }))
    .filter((s) => s.items.length > 0);
}

const stripBase = (pathname: string, slug: string) => {
  const prefix = `/${slug}`;
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  return pathname.slice(prefix.length).replace(/^\/+|\/+$/g, "");
};

/** Whether `pathname` is on an item's page (or beneath it, unless the item is `exact`). */
export function isItemActive(item: NavItem, pathname: string, slug: string): boolean {
  const rest = stripBase(pathname, slug);
  if (rest === null) return false;
  if (rest === item.path) return true;
  return !item.exact && rest.startsWith(`${item.path}/`);
}

/**
 * Pages that belong to an area without being listed in its sidebar: detail pages and the like.
 * Matched on the first path segment.
 */
const extraRoots: Record<string, AreaId> = {
  suppliers: "items",
  workforce: "people",
  concerns: WORKSPACE_AREA,
  "org-chart": WORKSPACE_AREA,
};

/**
 * The area a page belongs to, or `null` for pages that belong to none (the inbox, tasks, the calendar,
 * the wiki). Chosen by the longest matching item path so `workforce/hr` wins over `workforce`.
 */
export function areaForPath(pathname: string, slug: string): AreaId | null {
  const rest = stripBase(pathname, slug);
  if (!rest) return null;
  let best: { id: AreaId; length: number } | null = null;
  for (const area of navAreas) {
    for (const section of area.sections) {
      for (const item of section.items) {
        if (rest === item.path || rest.startsWith(`${item.path}/`)) {
          if (!best || item.path.length > best.length) best = { id: area.id, length: item.path.length };
        }
      }
    }
  }
  if (best) return best.id;
  const root = rest.split("/")[0] ?? "";
  if (root === "settings") return WORKSPACE_AREA;
  return extraRoots[root] ?? (isAreaId(root) ? root : null);
}

/** Where an area opens: its first visible page. */
export function areaHref(area: NavArea, slug: string, access: NavAccess): string {
  const first = visibleSections(area, access).flatMap((s) => s.items)[0];
  return `/${slug}${first?.path ? `/${first.path}` : ""}`;
}

/**
 * The area to show: the one the current page belongs to, else the viewer's last choice, else
 * their default, else the workspace area. Always an area the viewer can open.
 */
export function resolveArea(input: {
  pathname: string;
  slug: string;
  stored: string | null | undefined;
  preferred: string | null | undefined;
  access: NavAccess;
}): NavArea {
  const open = visibleAreas(input.access);
  const allowed = (id: string | null | undefined) => open.find((a) => a.id === id);
  return (
    allowed(areaForPath(input.pathname, input.slug)) ??
    allowed(input.stored) ??
    allowed(input.preferred) ??
    (getArea(WORKSPACE_AREA) as NavArea)
  );
}

/** Group the areas for the picker, keeping each group's order. */
export function groupAreas(areas: readonly NavArea[]): { group: NavArea["group"]; areas: NavArea[] }[] {
  const out: { group: NavArea["group"]; areas: NavArea[] }[] = [];
  for (const area of areas) {
    const found = out.find((g) => g.group === area.group);
    if (found) found.areas.push(area);
    else out.push({ group: area.group, areas: [area] });
  }
  return out;
}

/**
 * Where "/{slug}" lands: the viewer's default area when they set one, else the first thing they
 * can use (the old behaviour).
 */
export function homePath(input: { slug: string; preferred: string | null | undefined; access: NavAccess }) {
  const { slug, access } = input;
  const area = visibleAreas(access).find((a) => a.id === input.preferred);
  if (area) return areaHref(area, slug, access);
  return `/${slug}/${access.can("tasks") ? "my-tasks" : access.can("docs") ? "docs" : "inbox"}`;
}
