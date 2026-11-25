import { ApiError, createApiClient, unwrap } from "@knotworking/api-client";
import {
  hasModuleLevel,
  type AllergenCode,
  type ClauseAssessmentStatus,
  type CcpLogReviewStatus,
  type CostingBatchListStatus,
  type CostingPeriod,
  type DemandForecast,
  type DemandSource,
  type ItemType,
  type LotStatus,
  type ModuleId,
  type ProductionBatchStatus,
  type PurchaseCreditNoteListStatus,
  type PurchaseInvoiceListStatus,
  type PurchaseOrderListStatus,
  type PurchaseRequestListQuery,
  type NutritionSource,
  type ProductLabelStatus,
  type SpecificationKind,
  type SpecificationReviewFilter,
  type TestInvestigationStatus,
  type TestOutcome,
  type TestSampleStatus,
  type TrainingStatus,
  effectiveCurrency,
  effectiveTimeZone,
  todayInZone,
} from "@knotworking/core";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

/**
 * Server-side API access. The web app talks to the same HTTP API that desktop
 * and mobile clients will use — it never touches the database directly. The
 * signed-in user's session cookie is forwarded on every call.
 */
export const API_URL = process.env.API_URL ?? "http://127.0.0.1:4000";

async function client() {
  const cookie = (await headers()).get("cookie") ?? "";
  return createApiClient(API_URL, { headers: { cookie } });
}

/** Request-time only; 401 → login page, 404 (or a module the viewer can't use) → not-found page. */
async function load<T>(request: (api: Awaited<ReturnType<typeof client>>) => Promise<T>): Promise<T> {
  const api = await client();
  try {
    return await request(api);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect("/login");
    if (err instanceof ApiError && err.status === 404) notFound();
    // A module the viewer can't use looks like a page that doesn't exist.
    if (err instanceof ApiError && err.code === "module_forbidden") notFound();
    throw err;
  }
}

const ws = (api: Awaited<ReturnType<typeof client>>) => api.v1.workspaces[":slug"];

export const getCustomers = (
  slug: string,
  query: { q?: string; status?: "active" | "archived" | "all"; offset?: string } = {},
) => load((api) => unwrap(ws(api).customers.$get({ param: { slug }, query })));
export const getDespatches = (
  slug: string,
  query: { status?: "draft" | "confirmed" | "voided" | "all"; offset?: string } = {},
) => load((api) => unwrap(ws(api).despatch.$get({ param: { slug }, query })));
export const getDespatch = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).despatch[":id"].$get({ param: { slug, id } })));
export const getLotRecipients = (slug: string, lotId: string, offset = "0") =>
  load((api) =>
    unwrap(ws(api).despatch.lots[":lotId"].recipients.$get({ param: { slug, lotId }, query: { offset } })),
  );
export const getDespatchImpact = (
  slug: string,
  lotId: string,
  query: { depth?: string; offset?: string } = {},
) => load((api) => unwrap(ws(api).despatch.lots[":lotId"].impact.$get({ param: { slug, lotId }, query })));
/** Historical trace roots include lots with no remaining stock. */
export const findImpactLots = (slug: string, q: string) =>
  load((api) =>
    unwrap(
      ws(api).stock.lots.$get({
        param: { slug },
        query: { q, includeEmpty: "true", order: "newest", limit: "50" },
      }),
    ),
  );
export type Customer = Awaited<ReturnType<typeof getCustomers>>["customers"][number];
export type Despatch = Awaited<ReturnType<typeof getDespatch>>;

// `cache` dedupes calls within a single server render (layout + page).
export const getMe = cache(() => load((api) => unwrap(api.v1.me.$get())));

/** Signed-in user, or null (for public pages like /login). */
export const getOptionalMe = cache(async () => {
  try {
    return await unwrap((await client()).v1.me.$get());
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
});

export const getAuthConfig = cache(async () => unwrap((await client()).v1.public["auth-config"].$get()));

export const getBootstrap = cache((slug: string) =>
  load((api) => unwrap(ws(api).bootstrap.$get({ param: { slug } }))),
);

export const getWorkspaceModuleSettings = cache((slug: string) =>
  load((api) => unwrap(ws(api)["module-settings"].$get({ param: { slug } }))),
);

export const getPurchaseRequests = (slug: string, query: PurchaseRequestListQuery) =>
  load((api) => unwrap(ws(api)["purchase-requests"].$get({ param: { slug }, query })));

export const getPurchaseRequest = (slug: string, id: string) =>
  load((api) => unwrap(ws(api)["purchase-requests"][":id"].$get({ param: { slug, id } })));

export const getServiceQuotes = (slug: string, query: { before?: string }) =>
  load((api) => unwrap(ws(api)["client-services"].$get({ param: { slug }, query })));

export const getServiceQuote = (slug: string, id: string) =>
  load((api) => unwrap(ws(api)["client-services"][":id"].$get({ param: { slug, id } })));

export type ServiceQuote = Awaited<ReturnType<typeof getServiceQuote>>;

/**
 * The workspace's time zone (from the bootstrap): server components decide business dates in it
 * ("today", the current week, print ranges), never in the server's or the browser's zone.
 */
export const getWorkspaceTimeZone = cache(
  async (slug: string) => effectiveTimeZone((await getBootstrap(slug)).workspace.timeZone).timeZone,
);

/** The workspace's currency (ISO 4217, `GBP` by default): server components show money in it. */
export const getWorkspaceCurrency = cache(async (slug: string) =>
  effectiveCurrency((await getBootstrap(slug)).workspace.currency),
);

/** Today (`YYYY-MM-DD`) in the workspace's time zone. */
export const getWorkspaceToday = async (slug: string) => todayInZone(await getWorkspaceTimeZone(slug));

export const getTask = cache((slug: string, id: string) =>
  load((api) => unwrap(ws(api).tasks[":id"].$get({ param: { slug, id } }))),
);

/** Comments are fetched per task, not bootstrapped (see docs/architecture.md). */
export const getTaskComments = cache((slug: string, id: string) =>
  load((api) => unwrap(ws(api).tasks[":id"].comments.$get({ param: { slug, id } }))),
);

/** Files attached to a task, fetched per task like comments. */
export const getTaskAttachments = cache((slug: string, id: string) =>
  load((api) => unwrap(ws(api).tasks[":id"].attachments.$get({ param: { slug, id } }))),
);

export const getProjects = cache((slug: string) =>
  load((api) => unwrap(ws(api).projects.$get({ param: { slug } }))),
);

export const getDocument = cache((slug: string, id: string) =>
  load((api) => unwrap(ws(api).documents[":id"].$get({ param: { slug, id } }))),
);

/** Documents and tasks that mention this document ("Linked from"). */
export const getDocumentBacklinks = cache((slug: string, id: string) =>
  load((api) => unwrap(ws(api).documents[":id"].backlinks.$get({ param: { slug, id } }))),
);

/** Documents and tasks that mention this task ("Mentioned in"). */
export const getTaskBacklinks = cache((slug: string, id: string) =>
  load((api) => unwrap(ws(api).tasks[":id"].backlinks.$get({ param: { slug, id } }))),
);
/** The time report (see `services/time-report.ts`); `query` is what `filtersToApiQuery` returns. */
export const getTimeReport = (
  slug: string,
  query: {
    from: string;
    to: string;
    groupBy: "project" | "person" | "task" | "day";
    projectId?: string;
    teamId?: string;
    userId?: string;
  },
) => load((api) => unwrap(ws(api)["time-report"].$get({ param: { slug }, query })));

/** Admin view of who can use which module (owners and admins only). */
export const getModuleAccess = cache((slug: string) =>
  load((api) => unwrap(ws(api).members["module-access"].$get({ param: { slug } }))),
);

/**
 * For pages of one module: 404 unless the module is active here and the viewer can read it. (The
 * API refuses the data anyway; this keeps a hidden module's pages from rendering empty shells.)
 * `level` raises the bar for pages that only people with that access use (e.g. a review queue).
 */
export async function requireModule(
  slug: string,
  moduleId: ModuleId,
  level: "read" | "write" | "manage" = "read",
) {
  const boot = await getBootstrap(slug);
  if (!hasModuleLevel(boot.modules.find((m) => m.id === moduleId)?.access, level)) notFound();
}

/** Whether the viewer can at least read a module (for optional cross-module data on a page). */
export async function canReadModule(slug: string, moduleId: ModuleId) {
  const boot = await getBootstrap(slug);
  return hasModuleLevel(boot.modules.find((m) => m.id === moduleId)?.access, "read");
}

/** Items module: one page of items (see `itemListQuerySchema`). */
export const getItems = (
  slug: string,
  query: {
    q?: string;
    type?: ItemType;
    status?: "active" | "archived" | "all";
    allergen?: AllergenCode;
    offset?: string;
  },
) => load((api) => unwrap(ws(api).items.$get({ param: { slug }, query: { ...query, limit: "100" } })));

/**
 * Items module: every item matching the filters, fetched a page (200, the API's maximum) at a time.
 * For pickers that must offer all of them, such as the demand grid's products.
 */
export const getAllItems = (
  slug: string,
  query: { q?: string; type?: ItemType; status?: "active" | "archived" | "all"; allergen?: AllergenCode },
) =>
  load(async (api) => {
    const PAGE = 200;
    const first = await unwrap(
      ws(api).items.$get({ param: { slug }, query: { ...query, limit: String(PAGE), offset: "0" } }),
    );
    const all = [...first.items];
    while (all.length < first.total) {
      const page = await unwrap(
        ws(api).items.$get({
          param: { slug },
          query: { ...query, limit: String(PAGE), offset: String(all.length) },
        }),
      );
      if (page.items.length === 0) break;
      all.push(...page.items);
    }
    return { ...first, items: all, limit: all.length };
  });

/**
 * Every item for a picker on another module's page, or none when the viewer can't read Items
 * (a soft dependency there: the picker is then hidden).
 */
export const getItemOptions = async (slug: string, query: Parameters<typeof getAllItems>[1]) =>
  (await canReadModule(slug, "items")) ? (await getAllItems(slug, query)).items : [];

/** Recipes module: one page of recipes (see `recipeListQuerySchema`). */
export const getRecipes = (
  slug: string,
  query: { q?: string; status?: "active" | "archived" | "all"; allergenDrift?: "true"; offset?: string },
) => load((api) => unwrap(ws(api).recipes.$get({ param: { slug }, query: { ...query, limit: "100" } })));

/** A recipe with its version list, current version in full and any draft in progress. */
export const getRecipe = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).recipes[":id"].$get({ param: { slug, id } })));

/** Specifications module: one page of specifications (see `specificationListQuerySchema`). */
export const getSpecifications = (
  slug: string,
  query: {
    q?: string;
    status?: "active" | "archived" | "all";
    kind?: SpecificationKind;
    review?: SpecificationReviewFilter;
    itemId?: string;
    offset?: string;
  },
) =>
  load((api) => unwrap(ws(api).specifications.$get({ param: { slug }, query: { ...query, limit: "100" } })));

/** A specification with its versions, approved and draft content, changes, blockers and item checks. */
export const getSpecification = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).specifications[":id"].$get({ param: { slug, id } })));

/** What a specification change could affect: recipes, labels and open batches the viewer can read. */
export const getSpecificationImpact = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).specifications[":id"].impact.$get({ param: { slug, id } })));

/** Product development projects: open ones, or all. */
export const getNpdProjects = (slug: string, status: "open" | "all") =>
  load((api) => unwrap(ws(api).npd.projects.$get({ param: { slug }, query: { status, limit: "200" } })));
/** A project with its trials and launch checklist. */
export const getNpdProject = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).npd.projects[":id"].$get({ param: { slug, id } })));

/** Food defence: what needs attention. */
export const getDefenceOverview = (slug: string) =>
  load((api) => unwrap(ws(api).defence.overview.$get({ param: { slug } })));
export const getDefenceAssessments = (slug: string) =>
  load((api) => unwrap(ws(api).defence.assessments.$get({ param: { slug } })));
/** An assessment with its approved version, draft, history and exercises. */
export const getDefenceAssessment = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).defence.assessments[":id"].$get({ param: { slug, id } })));
export const getDefenceControls = (slug: string, status: "active" | "all") =>
  load((api) => unwrap(ws(api).defence.controls.$get({ param: { slug }, query: { status } })));
export const getDefenceChecks = (slug: string, outcome: "open" | "all") =>
  load((api) => unwrap(ws(api).defence.checks.$get({ param: { slug }, query: { outcome, limit: "100" } })));
export const getDefenceExercises = (slug: string) =>
  load((api) => unwrap(ws(api).defence.exercises.$get({ param: { slug } })));

/** Governance (management review). */
export const getGovernanceOverview = (slug: string) =>
  load((api) => unwrap(ws(api).governance.overview.$get({ param: { slug } })));
export const getGovernanceObjectives = (slug: string) =>
  load((api) => unwrap(ws(api).governance.objectives.$get({ param: { slug } })));
export const getGovernanceCulture = (slug: string) =>
  load((api) => unwrap(ws(api).governance.culture.$get({ param: { slug } })));
export const getGovernanceRequirements = (slug: string) =>
  load((api) => unwrap(ws(api).governance.requirements.$get({ param: { slug } })));
export const getGovernanceConcerns = (slug: string) =>
  load((api) => unwrap(ws(api).governance.concerns.$get({ param: { slug } })));
export const getManagementReviews = (slug: string) =>
  load((api) => unwrap(ws(api).governance.reviews.$get({ param: { slug } })));
export const getManagementReview = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).governance.reviews[":id"].$get({ param: { slug, id } })));
/** The standards library with each standard's gap analysis progress (G1). */
export const getStandards = (slug: string) =>
  load((api) => unwrap(ws(api).governance.standards.$get({ param: { slug } })));
/** A standard's gap analysis: summary and clauses with their latest assessment (G1). */
export const getGapAnalysis = (
  slug: string,
  id: string,
  query: {
    status?: ClauseAssessmentStatus;
    section?: string;
    fundamental?: "true" | "false";
    q?: string;
    evidence?: "gap" | "conflict" | "none";
    drafts?: "open";
  },
) => load((api) => unwrap(ws(api).governance.standards[":id"].$get({ param: { slug, id }, query })));
/** A standard's pre-audit snapshots, newest first. */
export const getGapSnapshots = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).governance.standards[":id"].snapshots.$get({ param: { slug, id } })));
/** A frozen gap analysis, with what has changed since. */
export const getGapSnapshot = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).governance.snapshots[":id"].$get({ param: { slug, id } })));
/** The viewer's own named concerns (404 when Governance is off). */
export const getMyConcerns = (slug: string) =>
  load((api) => unwrap(ws(api).concerns.mine.$get({ param: { slug } })));

/** Every supplier's risk level and the control issues to act on. */
/** Whether open supplier control issues only show or also block approval and orders. */
export const getSupplierControlSettings = (slug: string) =>
  load((api) => unwrap(ws(api).suppliers["control-settings"].$get({ param: { slug } })));
export const getSupplierCompliance = (slug: string) =>
  load((api) => unwrap(ws(api).suppliers.compliance.$get({ param: { slug } })));
/** One supplier's risk assessments, control states, questionnaires and issues. */
export const getSupplierControls = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).suppliers[":id"].controls.$get({ param: { slug, id } })));
export const getSupplier = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).suppliers[":id"].$get({ param: { slug, id } })));

/** What releasing a lot would be checked against, as it stands. */
export const getLotReleaseCheck = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).stock.lots[":id"]["release-check"].$get({ param: { slug, id } })));
/** A lot's releases, newest first, with the checks and rule version each was made under. */
export const getLotReleases = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).stock.lots[":id"].releases.$get({ param: { slug, id } })));
/** A lot's release exception requests (one manager asks, another approves), newest first. */
export const getLotReleaseExceptions = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).stock.lots[":id"]["release-exceptions"].$get({ param: { slug, id } })));
/** Every item's QA release rule. */
export const getReleaseRules = (slug: string) =>
  load((api) => unwrap(ws(api).stock["release-rules"].$get({ param: { slug } })));

/** Testing module: one page of samples (see `testSampleListQuerySchema`). */
export const getTestSamples = (
  slug: string,
  query: {
    q?: string;
    status?: TestSampleStatus | "all";
    outcome?: TestOutcome;
    investigation?: TestInvestigationStatus;
    offset?: string;
  },
) =>
  load((api) => unwrap(ws(api).testing.samples.$get({ param: { slug }, query: { ...query, limit: "100" } })));

/** A sample with its results, limits and investigation. */
export const getTestSample = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).testing.samples[":id"].$get({ param: { slug, id } })));

export const getTestPlans = (slug: string, status: "active" | "archived" | "all" = "active") =>
  load((api) => unwrap(ws(api).testing.plans.$get({ param: { slug }, query: { status } })));
export const getTestLaboratories = (slug: string, status: "active" | "archived" | "all" = "active") =>
  load((api) => unwrap(ws(api).testing.laboratories.$get({ param: { slug }, query: { status } })));
export const getSamplingPoints = (slug: string, status: "active" | "archived" | "all" = "active") =>
  load((api) => unwrap(ws(api).testing.points.$get({ param: { slug }, query: { status } })));
export const getTestAnalytes = (slug: string) =>
  load((api) => unwrap(ws(api).testing.analytes.$get({ param: { slug } })));
export const getTestTrend = (
  slug: string,
  query: { analyte: string; zone?: string; itemId?: string; samplingPointId?: string },
) => load((api) => unwrap(ws(api).testing.trends.$get({ param: { slug }, query })));

export const getSuppliers = cache((slug: string) =>
  load((api) => unwrap(ws(api).suppliers.$get({ param: { slug }, query: {} }))),
);

/** People module: the staff register (everyone, leavers included; the page filters). */
export const getStaffList = (slug: string) =>
  load((api) =>
    unwrap(ws(api).people.staff.$get({ param: { slug }, query: { status: "all", limit: "500" } })),
  );

export const getJobRoles = (slug: string) =>
  load((api) => unwrap(ws(api).people["job-roles"].$get({ param: { slug }, query: { status: "all" } })));

/** Quality module. */
export const getQualitySummary = (slug: string) =>
  load((api) => unwrap(ws(api).quality.summary.$get({ param: { slug } })));

export const getComplaints = (
  slug: string,
  query: { status?: "open" | "investigating" | "closed" | "unresolved" | "all"; q?: string; offset?: string },
) =>
  load((api) =>
    unwrap(ws(api).quality.complaints.$get({ param: { slug }, query: { ...query, limit: "100" } })),
  );

export const getComplaint = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).quality.complaints[":id"].$get({ param: { slug, id } })));

export const getNonconformances = (
  slug: string,
  query: {
    status?: "open" | "action_taken" | "closed" | "unresolved" | "overdue" | "all";
    q?: string;
    auditId?: string;
    offset?: string;
  },
) =>
  load((api) =>
    unwrap(ws(api).quality.nonconformances.$get({ param: { slug }, query: { ...query, limit: "100" } })),
  );

export const getNonconformance = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).quality.nonconformances[":id"].$get({ param: { slug, id } })));

export const getAudits = (slug: string, query: { status?: "planned" | "completed" | "cancelled" | "all" }) =>
  load((api) => unwrap(ws(api).quality.audits.$get({ param: { slug }, query: { ...query, limit: "200" } })));

export const getAudit = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).quality.audits[":id"].$get({ param: { slug, id } })));

export const getAuditProgrammes = (slug: string) =>
  load((api) => unwrap(ws(api).quality["audit-programmes"].$get({ param: { slug } })));

export const getComplaintTrends = (slug: string, months: number) =>
  load((api) => unwrap(ws(api).quality.trends.$get({ param: { slug }, query: { months: String(months) } })));

export const getSupplierQuality = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).quality.suppliers[":id"].$get({ param: { slug, id } })));

export const getRecallTests = (slug: string, query: { includeVoided?: "true" }) =>
  load((api) =>
    unwrap(ws(api).quality["recall-tests"].$get({ param: { slug }, query: { ...query, limit: "200" } })),
  );

/** Purchasing module: one page of orders, newest first (see `purchaseOrderListQuerySchema`). */
export const getPurchaseOrders = (
  slug: string,
  query: { status?: PurchaseOrderListStatus; q?: string; supplierId?: string; offset?: string },
) =>
  load((api) =>
    unwrap(ws(api).purchasing.orders.$get({ param: { slug }, query: { ...query, limit: "50" } })),
  );

/** One order: lines with what was received, rejected and is outstanding, and its deliveries. */
export const getPurchaseOrder = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).purchasing.orders[":id"].$get({ param: { slug, id } })));

/** Purchasing module: one page of supplier invoices, latest invoice date first. */
export const getPurchaseInvoices = (
  slug: string,
  query: {
    status?: PurchaseInvoiceListStatus;
    q?: string;
    supplierId?: string;
    purchaseOrderId?: string;
    offset?: string;
  },
) =>
  load((api) =>
    unwrap(ws(api).purchasing.invoices.$get({ param: { slug }, query: { ...query, limit: "50" } })),
  );

/** One invoice with its lines matched against order and delivery, and its versions. */
export const getPurchaseInvoice = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).purchasing.invoices[":id"].$get({ param: { slug, id } })));

/** The workspace's three-way match tolerances. */
export const getInvoiceTolerances = (slug: string) =>
  load((api) => unwrap(ws(api).purchasing["invoice-settings"].$get({ param: { slug } })));

/** The workspace's order controls: approval threshold for sending and over-delivery tolerance. */
export const getPurchaseSettings = (slug: string) =>
  load((api) => unwrap(ws(api).purchasing.settings.$get({ param: { slug } })));

/** Purchasing module: supplier price list entries, supplier then item, latest effective date first. */
export const getSupplierPrices = (
  slug: string,
  query: { supplierId?: string; itemId?: string; offset?: string },
) =>
  load((api) =>
    unwrap(ws(api).purchasing.prices.$get({ param: { slug }, query: { ...query, limit: "100" } })),
  );

/** Purchasing module: one page of supplier credit notes, latest credit date first. */
export const getPurchaseCreditNotes = (
  slug: string,
  query: {
    status?: PurchaseCreditNoteListStatus;
    q?: string;
    supplierId?: string;
    invoiceId?: string;
    offset?: string;
  },
) =>
  load((api) =>
    unwrap(ws(api).purchasing["credit-notes"].$get({ param: { slug }, query: { ...query, limit: "50" } })),
  );

/** One credit note with its lines and the invoice lines they credit. */
export const getPurchaseCreditNote = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).purchasing["credit-notes"][":id"].$get({ param: { slug, id } })));

/**
 * What to order from production's material shortfall, by suggested supplier. `unavailable` (with
 * the API's message) when production is off or the viewer can't read it.
 */
export const getPurchaseSuggestions = (slug: string, query: { from?: string; to?: string }) =>
  load(async (api) => {
    try {
      return {
        unavailable: null,
        data: await unwrap(ws(api).purchasing.suggestions.$get({ param: { slug }, query })),
      };
    } catch (err) {
      if (err instanceof ApiError && err.code === "production_unavailable")
        return { unavailable: err.message, data: null };
      throw err;
    }
  });

/**
 * Labels module: product labels with whether each is stale (see `productLabelListQuerySchema`), a
 * page of 100 from `offset`.
 */
export const getProductLabels = (
  slug: string,
  query: {
    status?: "current" | "all" | ProductLabelStatus;
    stale?: "true" | "false";
    q?: string;
    offset?: string;
  },
) =>
  load((api) =>
    unwrap(ws(api).labelling.labels.$get({ param: { slug }, query: { ...query, limit: "100" } })),
  );

/** One label with its recipe, staleness, the data computed now and the label's history. */
export const getProductLabel = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).labelling.labels[":id"].$get({ param: { slug, id } })));

/** A label as it would read for any recipe version, computed now and never stored (see `preview.watermark`). */
export const getLabelPreview = (slug: string, recipeId: string, versionId: string) =>
  load((api) =>
    unwrap(
      ws(api).labelling.recipes[":id"].versions[":versionId"].$get({
        param: { slug, id: recipeId, versionId },
        query: {},
      }),
    ),
  );

/** Food items with their labelling data and where their nutrition comes from. */
export const getLabellingItems = (
  slug: string,
  query: { nutrition?: "all" | NutritionSource; q?: string; offset?: string },
) =>
  load((api) => unwrap(ws(api).labelling.items.$get({ param: { slug }, query: { ...query, limit: "200" } })));

/** On time, in full and rejected deliveries per supplier (default the last 90 days). */
export const getSupplierPerformance = (slug: string, query: { from?: string; to?: string }) =>
  load((api) => unwrap(ws(api).purchasing["supplier-performance"].$get({ param: { slug }, query })));

/** Costing module: batches with their headline cost, newest costing date first. */
export const getBatchCosts = (
  slug: string,
  query: {
    status?: CostingBatchListStatus;
    q?: string;
    from?: string;
    to?: string;
    outputItemId?: string;
    offset?: string;
  },
) =>
  load((api) => unwrap(ws(api).costing.batches.$get({ param: { slug }, query: { ...query, limit: "50" } })));

/**
 * One batch's cost in full: consumed lots with their sources, materials, yield and variances.
 * Cached per render: the batch cost page reads it in `generateMetadata` and the page.
 */
export const getBatchCost = cache((slug: string, id: string) =>
  load((api) => unwrap(ws(api).costing.batches[":id"].$get({ param: { slug, id } }))),
);

/**
 * Standard against actual by product and period. `error` (the API's message) when a bound can't
 * be read or the window is too long, so the page can say so instead of failing.
 */
export const getCostingReport = (
  slug: string,
  query: { period?: CostingPeriod; from?: string; to?: string; outputItemId?: string },
) =>
  load(async (api) => {
    try {
      return { error: null, data: await unwrap(ws(api).costing.report.$get({ param: { slug }, query })) };
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) return { error: err.message, data: null };
      throw err;
    }
  });

/** Costing: stock on hand valued at lot cost. */
export const getStockValuation = (
  slug: string,
  query: { itemType?: ItemType; status?: "available" | "quarantine" | "rejected"; q?: string },
) => load((api) => unwrap(ws(api).costing.valuation.$get({ param: { slug }, query })));

/** Costing: labour and overhead absorption rates, with the production lines they can be set for. */
export const getAbsorptionRates = (slug: string) =>
  load((api) => unwrap(ws(api).costing.rates.$get({ param: { slug } })));

/** Training module. */
export const getTrainingCourses = (slug: string) =>
  load((api) => unwrap(ws(api).training.courses.$get({ param: { slug }, query: { status: "all" } })));

export const getTrainingMatrix = (
  slug: string,
  query: { jobRoleId?: string; department?: string; status?: TrainingStatus; allCourses?: "true" | "false" },
) => load((api) => unwrap(ws(api).training.matrix.$get({ param: { slug }, query })));

export const getTrainingDue = (slug: string, query: { withinDays?: string; jobRoleId?: string } = {}) =>
  load((api) => unwrap(ws(api).training.due.$get({ param: { slug }, query })));

export const getPendingSignOffs = (slug: string) =>
  load((api) =>
    unwrap(ws(api).training.records.$get({ param: { slug }, query: { signOff: "pending", limit: "500" } })),
  );

export const getStaffTraining = (slug: string, staffId: string) =>
  load((api) => unwrap(ws(api).training.staff[":staffId"].$get({ param: { slug, staffId } })));

/** Attendance module. */
export const getAttendanceSettings = (slug: string) =>
  load((api) => unwrap(ws(api).attendance.settings.$get({ param: { slug } })));

export const getOnSite = (slug: string) =>
  load((api) => unwrap(ws(api).attendance["on-site"].$get({ param: { slug } })));

export const getRollCalls = (slug: string) =>
  load((api) => unwrap(ws(api).attendance["roll-calls"].$get({ param: { slug } })));

export const getRollCall = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).attendance["roll-calls"][":id"].$get({ param: { slug, id } })));

export const getShifts = (slug: string, query: { from: string; to: string; issues?: "true" }) =>
  load((api) => unwrap(ws(api).attendance.shifts.$get({ param: { slug }, query })));

export const getPayrollPreview = (slug: string, query: { from?: string; to?: string; format?: string }) =>
  load((api) => unwrap(ws(api).attendance.payroll.$get({ param: { slug }, query })));

export const getVisits = (slug: string, query: { from: string; to: string }) =>
  load((api) => unwrap(ws(api).attendance.visits.$get({ param: { slug }, query })));

export const getVisit = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).attendance.visits[":id"].$get({ param: { slug, id } })));

export const getKioskDevices = (slug: string) =>
  load((api) => unwrap(ws(api).attendance.devices.$get({ param: { slug } })));

export const getKioskBadges = (slug: string) =>
  load((api) => unwrap(ws(api).attendance.badges.$get({ param: { slug } })));

export const getKioskRejections = (slug: string) =>
  load((api) =>
    unwrap(ws(api).attendance["kiosk-rejections"].$get({ param: { slug }, query: { include: "open" } })),
  );

/** Stock module: one page of stock levels (see `stockLevelsQuerySchema`). */
export const getStockLevels = (
  slug: string,
  query: { q?: string; itemType?: ItemType; locationId?: string; expiringWithinDays?: string },
) => load((api) => unwrap(ws(api).stock.levels.$get({ param: { slug }, query: { ...query, limit: "200" } })));

export const getStockLocations = cache((slug: string, status: "active" | "all" = "active") =>
  load((api) => unwrap(ws(api).stock.locations.$get({ param: { slug }, query: { status } }))),
);

/** Lots in FEFO order with their balances per location (see `stockLotListQuerySchema`). */
export const getStockLots = (
  slug: string,
  query: { itemId?: string; locationId?: string; status?: LotStatus },
) => load((api) => unwrap(ws(api).stock.lots.$get({ param: { slug }, query: { ...query, limit: "200" } })));

/** One lot with its supplier, balances and full movement history. */
export const getStockLot = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).stock.lots[":id"].$get({ param: { slug, id } })));

/** Demand module: totals per item (and customer) per ISO week (see `demandSummaryQuerySchema`). */
export const getDemandSummary = (slug: string, query: { from?: string; to?: string; byCustomer?: "true" }) =>
  load((api) => unwrap(ws(api).demand.summary.$get({ param: { slug }, query })));

/** Units of sale (pack units) of every product. */
export const getDemandPackUnits = (slug: string) =>
  load((api) => unwrap(ws(api).demand["pack-units"].$get({ param: { slug }, query: {} })));

/** Demand against stock and planned batches (see `demandCoverageQuerySchema`). */
export const getDemandCoverage = (slug: string, query: { from?: string; to?: string; shortOnly?: "true" }) =>
  load((api) => unwrap(ws(api).demand.coverage.$get({ param: { slug }, query })));

/** Demand shortfall and planned batches against production line capacity (production readers only). */
export const getDemandCapacity = (slug: string, query: { from?: string; to?: string }) =>
  load((api) => unwrap(ws(api).demand.capacity.$get({ param: { slug }, query })));

/** One page of demand lines (see `demandLineListQuerySchema`). */
export const getDemandLines = (
  slug: string,
  query: {
    itemId?: string;
    from?: string;
    to?: string;
    customer?: string;
    source?: DemandSource;
    importId?: string;
    q?: string;
    offset?: string;
  },
) => load((api) => unwrap(ws(api).demand.lines.$get({ param: { slug }, query: { ...query, limit: "100" } })));

/** Recent CSV imports, newest first. */
export const getDemandImports = (slug: string) =>
  load((api) => unwrap(ws(api).demand.imports.$get({ param: { slug }, query: { limit: "20" } })));
/** Production module: batches in planned-date order (see `productionBatchListQuerySchema`). */
export const getProductionBatches = (
  slug: string,
  query: { from?: string; to?: string; status?: ProductionBatchStatus | "open" | "all"; q?: string },
) =>
  load((api) =>
    unwrap(ws(api).production.batches.$get({ param: { slug }, query: { ...query, limit: "200" } })),
  );

/** One batch: materials against consumption, the lots it produced and the full batch record. */
export const getProductionBatch = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).production.batches[":id"].$get({ param: { slug, id } })));

/** What the open batches between two dates need, against usable stock. */
export const getMaterialRequirements = (slug: string, from: string, to: string) =>
  load((api) => unwrap(ws(api).production.requirements.$get({ param: { slug }, query: { from, to } })));

/** Batches proposed from demand per item and ISO week (see `planFromDemandQuerySchema`). */
export const getPlanFromDemand = (slug: string, query: { from?: string; to?: string; recipeIds?: string }) =>
  load((api) => unwrap(ws(api).production["plan-from-demand"].$get({ param: { slug }, query })));

/** Production lines with the recipes each can make and their rates. */
export const getProductionLines = (slug: string) =>
  load((api) => unwrap(ws(api).production.lines.$get({ param: { slug } })));

/** The line schedule: per line per day, hours against capacity (see `productionScheduleQuerySchema`). */
export const getProductionSchedule = (slug: string, from: string, to: string) =>
  load((api) => unwrap(ws(api).production.schedule.$get({ param: { slug }, query: { from, to } })));

/** One line's day timed against its shifts, with changeovers and a proposed order (3.5.1). */
export const getProductionDayPlan = (slug: string, lineId: string, date: string) =>
  load((api) => unwrap(ws(api).production.schedule.day.$get({ param: { slug }, query: { lineId, date } })));

/** Per product per day: confirmed commitments, planned output and projected stock (3.5.1). */
export const getProductionDailyDemand = (slug: string, days?: number) =>
  load((api) =>
    unwrap(
      ws(api).production["daily-demand"].$get({
        param: { slug },
        query: days ? { days: String(days) } : {},
      }),
    ),
  );

/** OEE per line per day with definitions, downtime and rejects by reason, labour and line cost (3.5.2). */
export const getProductionPerformance = (slug: string, from: string, to: string, lineId?: string) =>
  load((api) =>
    unwrap(
      ws(api).production.performance.$get({
        param: { slug },
        query: { from, to, ...(lineId ? { lineId } : {}) },
      }),
    ),
  );

/** Downtime records between two dates, voided ones included (3.5.2). */
export const getProductionDowntime = (slug: string, from: string, to: string, lineId?: string) =>
  load((api) =>
    unwrap(
      ws(api).production.downtime.$get({
        param: { slug },
        query: { from, to, ...(lineId ? { lineId } : {}) },
      }),
    ),
  );

/** A batch's rejects, labour and downtime with yield and standard against actual hours (3.5.2). */
export const getBatchPerformance = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).production.batches[":id"].performance.$get({ param: { slug, id } })));

/** A batch's packing runs, checks, gaps and what a new run may pin (3.5.3). */
export const getBatchPacking = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).production.batches[":id"].packing.$get({ param: { slug, id } })));

/** Registered line devices with their calibration state (3.5.4). */
export const getProductionDevices = (slug: string) =>
  load((api) => unwrap(ws(api).production.devices.$get({ param: { slug } })));

/** Reservations held on one lot (active ones), with the batches that hold them. */
export const getLotReservations = (slug: string, lotId: string) =>
  load((api) => unwrap(ws(api).production.reservations.$get({ param: { slug }, query: { lotId } })));

/** On hand usable today, reserved and available, for some items (comma-separated ids). */
export const getAvailability = (slug: string, itemIds: string[]) =>
  load((api) =>
    unwrap(ws(api).production.availability.$get({ param: { slug }, query: { itemIds: itemIds.join(",") } })),
  );

/** A lot traced through batch records, forward and backward, with its mass balance. */
export const getLotTrace = (slug: string, lotId: string) =>
  load((api) => unwrap(ws(api).production.lots[":lotId"].trace.$get({ param: { slug, lotId }, query: {} })));

/** HACCP module: plans with their current version (see `haccpPlanListQuerySchema`). */
export const getHaccpPlans = (slug: string, status: "active" | "archived" | "all" = "active") =>
  load((api) => unwrap(ws(api).haccp.plans.$get({ param: { slug }, query: { status, limit: "200" } })));

/** The hazard library: reusable hazards a plan's hazard analysis copies from. */
export const getHaccpLibrary = (slug: string) =>
  load((api) => unwrap(ws(api).haccp.library.$get({ param: { slug }, query: { limit: "200" } })));

/** Plan templates a new plan can be started from. */
export const getHaccpTemplates = (slug: string) =>
  load((api) => unwrap(ws(api).haccp.templates.$get({ param: { slug }, query: { limit: "200" } })));

/** One HACCP plan: the current approved version, the draft and the version history. */
export const getHaccpPlan = cache((slug: string, id: string) =>
  load((api) => unwrap(ws(api).haccp.plans[":id"].$get({ param: { slug, id } }))),
);

/** One version of a plan (superseded ones included). */
export const getHaccpPlanVersion = (slug: string, id: string, versionId: string) =>
  load((api) =>
    unwrap(ws(api).haccp.plans[":id"].versions[":versionId"].$get({ param: { slug, id, versionId } })),
  );

/** Scheduled checks and where each stands (`include: "all"` for those not yet due). */
export const getHaccpDue = (slug: string, include: "due" | "all" = "all") =>
  load((api) => unwrap(ws(api).haccp.due.$get({ param: { slug }, query: { include } })));

/** CCP checks, newest first. */
export const getHaccpLogs = (
  slug: string,
  query: {
    batchId?: string;
    outOfLimits?: "true" | "false";
    review?: CcpLogReviewStatus;
    includeCorrected?: "true" | "false";
    limit?: string;
  } = {},
) => load((api) => unwrap(ws(api).haccp.logs.$get({ param: { slug }, query: { limit: "50", ...query } })));

/** CCP readings from API tokens waiting for a person's review (corrected ones have left the queue). */
export const getHaccpReviewQueue = (slug: string) =>
  getHaccpLogs(slug, { review: "pending", includeCorrected: "false", limit: "200" });

/** How many CCP readings wait for review: shown in the food safety navigation. */
export const getHaccpAwaitingReviewCount = cache(
  async (slug: string) =>
    (await getHaccpLogs(slug, { review: "pending", includeCorrected: "false", limit: "1" })).total,
);

/** Corrective actions with what they answer (a deviation, a failed calibration). */
export const getCorrectiveActions = (slug: string, status: "open" | "closed" | "all") =>
  load((api) =>
    unwrap(ws(api).haccp["corrective-actions"].$get({ param: { slug }, query: { status, limit: "100" } })),
  );

/** Areas and equipment on the cleaning and calibration schedule. */
export const getHaccpAssets = (slug: string) =>
  load((api) => unwrap(ws(api).haccp.assets.$get({ param: { slug }, query: { status: "all" } })));

export const getCleaningRecords = (slug: string) =>
  load((api) => unwrap(ws(api).haccp.cleaning.$get({ param: { slug }, query: { limit: "50" } })));

export const getCalibrationRecords = (slug: string) =>
  load((api) => unwrap(ws(api).haccp.calibration.$get({ param: { slug }, query: { limit: "50" } })));

/** A production batch's food safety record: its CCP checks, the CCPs that cover it, open deviations. */
export const getHaccpBatchRecord = (slug: string, batchId: string) =>
  load((api) => unwrap(ws(api).haccp.batches[":batchId"].$get({ param: { slug, batchId } })));

/** Site programmes module: everything scheduled across the programmes, with what waits for a person. */
export const getSiteDue = cache((slug: string, include: "due" | "all" = "all") =>
  load((api) => unwrap(ws(api).site.due.$get({ param: { slug }, query: { include } }))),
);

/** Areas of the food safety register (where devices, items, assets, units and checklists are). */
export const getSiteAreas = (slug: string) =>
  load((api) => unwrap(ws(api).site.areas.$get({ param: { slug } })));

export const getPestDevices = (slug: string) =>
  load((api) => unwrap(ws(api).site.pest.devices.$get({ param: { slug }, query: { status: "all" } })));

export const getPestVisits = (slug: string) =>
  load((api) =>
    unwrap(
      ws(api).site.pest.visits.$get({ param: { slug }, query: { limit: "50", includeCorrected: "false" } }),
    ),
  );

/** Pest sightings over time per device, area or pest (visits a correction replaced are left out). */
export const getPestTrends = (slug: string, groupBy: "device" | "area" | "pest" = "device") =>
  load((api) => unwrap(ws(api).site.pest.trends.$get({ param: { slug }, query: { groupBy } })));

/** Equipment of the HACCP calibration register a maintained asset can be linked to. */
export const getCalibrationInstruments = (slug: string) =>
  load((api) => unwrap(ws(api).site["calibration-instruments"].$get({ param: { slug } })));

/** Open breakdowns and work requests first, then the newest closed ones. */
export const getWorkOrders = (slug: string) =>
  load((api) =>
    unwrap(
      ws(api).site.maintenance["work-orders"].$get({
        param: { slug },
        query: { status: "all", limit: "100" },
      }),
    ),
  );

export const getGlassItems = (slug: string) =>
  load((api) => unwrap(ws(api).site.glass.items.$get({ param: { slug }, query: { status: "all" } })));

export const getGlassBreakages = (slug: string) =>
  load((api) => unwrap(ws(api).site.glass.breakages.$get({ param: { slug }, query: { limit: "50" } })));

/** The newest glass condition checks (corrected ones left out). */
export const getGlassChecks = (slug: string) =>
  load((api) =>
    unwrap(
      ws(api).site.glass.checks.$get({ param: { slug }, query: { limit: "50", includeCorrected: "false" } }),
    ),
  );

export const getMaintenanceAssets = (slug: string) =>
  load((api) => unwrap(ws(api).site.maintenance.assets.$get({ param: { slug }, query: { status: "all" } })));

export const getMaintenanceTasks = (slug: string) =>
  load((api) => unwrap(ws(api).site.maintenance.tasks.$get({ param: { slug }, query: { status: "all" } })));

/**
 * The newest records plus every one still in a person's queue (older ones too, up to 200), so each
 * row waiting on someone has its buttons; the queue rows come after the newest, oldest last.
 */
const withQueue = <T extends { id: string }>(recent: T[], queue: T[]) => {
  const seen = new Set(recent.map((r) => r.id));
  return [...recent, ...queue.filter((r) => !seen.has(r.id))];
};

export const getMaintenanceRecords = (slug: string) =>
  load(async (api) => {
    const records = ws(api).site.maintenance.records;
    const [recent, queue] = await Promise.all([
      unwrap(records.$get({ param: { slug }, query: { limit: "50", includeCorrected: "false" } })),
      unwrap(
        records.$get({
          param: { slug },
          query: { limit: "200", includeCorrected: "false", awaitingClearance: "true" },
        }),
      ),
    ]);
    return { ...recent, records: withQueue(recent.records, queue.records) };
  });

export const getStorageUnits = (slug: string) =>
  load((api) => unwrap(ws(api).site.storage.units.$get({ param: { slug }, query: { status: "all" } })));

export const getStorageReadings = (slug: string) =>
  load(async (api) => {
    const readings = ws(api).site.storage.readings;
    const [recent, queue] = await Promise.all([
      unwrap(readings.$get({ param: { slug }, query: { limit: "50", includeCorrected: "false" } })),
      unwrap(
        readings.$get({
          param: { slug },
          query: { limit: "200", includeCorrected: "false", review: "pending" },
        }),
      ),
    ]);
    return { ...recent, readings: withQueue(recent.readings, queue.readings) };
  });

export const getSiteActions = (slug: string, status: "open" | "closed" | "all" = "open") =>
  load((api) => unwrap(ws(api).site.actions.$get({ param: { slug }, query: { status, limit: "100" } })));

export const getChecklistTemplates = (slug: string) =>
  load((api) =>
    unwrap(ws(api).site.checklists.templates.$get({ param: { slug }, query: { status: "all" } })),
  );

export const getChecklistChecks = (slug: string) =>
  load(async (api) => {
    const checks = ws(api).site.checklists.checks;
    const [recent, queue] = await Promise.all([
      unwrap(checks.$get({ param: { slug }, query: { limit: "50", includeCorrected: "false" } })),
      unwrap(
        checks.$get({
          param: { slug },
          query: { limit: "200", includeCorrected: "false", signOff: "pending" },
        }),
      ),
    ]);
    return { ...recent, checks: withQueue(recent.checks, queue.checks) };
  });

/** SOPs module: one page of SOPs (see `sopListQuerySchema`). */
export const getSops = (
  slug: string,
  query: {
    q?: string;
    category?: string;
    status?: "active" | "archived" | "all";
    due?: "overdue" | "soon";
  } = {},
) => load((api) => unwrap(ws(api).sops.$get({ param: { slug }, query: { ...query, limit: "100" } })));

/** One SOP: the current version, history, and (with `write`) the draft and the version in review. */
export const getSop = cache((slug: string, id: string) =>
  load((api) => unwrap(ws(api).sops[":id"].$get({ param: { slug, id } }))),
);

/** Who has acknowledged a version and who has not (SOPs `manage` only). */
export const getSopAcknowledgements = (slug: string, id: string, versionId: string) =>
  load((api) =>
    unwrap(
      ws(api).sops[":id"].versions[":versionId"].acknowledgements.$get({ param: { slug, id, versionId } }),
    ),
  );

/** One version of an SOP with its content (an in-review one needs `write`). */
export const getSopVersion = (slug: string, id: string, versionId: string) =>
  load((api) => unwrap(ws(api).sops[":id"].versions[":versionId"].$get({ param: { slug, id, versionId } })));

/** Who an SOP is aimed at (SOPs `manage` only). */
export const getSopTargets = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).sops[":id"].targets.$get({ param: { slug, id } })));

/** The controlled-copy register (SOPs `read`); default the copies still out. */
export const getSopCopies = (
  slug: string,
  query: { sopId?: string; status?: "issued" | "returned" | "destroyed" | "all"; limit?: string } = {},
) => load((api) => unwrap(ws(api).sops.copies.$get({ param: { slug }, query })));

export const getSopCopy = (slug: string, copyId: string) =>
  load((api) => unwrap(ws(api).sops.copies[":copyId"].$get({ param: { slug, copyId } })));

/** Acknowledgements still outstanding, for one SOP or person or all (SOPs `manage` only). */
export const getSopOutstanding = (slug: string, query: { sopId?: string; userId?: string } = {}) =>
  load((api) => unwrap(ws(api).sops.outstanding.$get({ param: { slug }, query })));

export const getMembers = cache((slug: string) =>
  load((api) => unwrap(ws(api).members.$get({ param: { slug } }))),
);

export const getInvitations = cache((slug: string) =>
  load((api) => unwrap(ws(api).invitations.$get({ param: { slug } }))),
);

/** Archived teams (owners and admins only). */
export const getArchivedTeams = cache((slug: string) =>
  load((api) => unwrap(ws(api).teams.archived.$get({ param: { slug } }))),
);

export const getInvitation = cache(async (token: string) => {
  try {
    return await unwrap((await client()).v1.public.invitations[":token"].$get({ param: { token } }));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
});

export const getCalendar = cache((slug: string, from: string, to: string) =>
  load((api) => unwrap(ws(api).calendar.$get({ param: { slug }, query: { from, to } }))),
);

export const getNotifications = (slug: string, query: { unread?: "true" | "false" } = {}) =>
  load((api) => unwrap(ws(api).notifications.$get({ param: { slug }, query })));

export const getUnreadCount = cache((slug: string) =>
  load((api) => unwrap(ws(api).notifications["unread-count"].$get({ param: { slug } }))).then(
    (r) => r.unreadCount,
  ),
);

export const getNotificationPreferences = (slug: string) =>
  load((api) => unwrap(ws(api).notifications.preferences.$get({ param: { slug } })));

export const getCalendarConnections = cache(() => load((api) => unwrap(api.v1.calendar.connections.$get())));

/** Not cached: the list must be fresh after creating or revoking a token. */
export const getApiTokens = () => load((api) => unwrap(api.v1.me["api-tokens"].$get()));

/** Which person-only actions tokens may do here (any member reads; `canManage` for owners and admins). */
export const getTokenActions = (slug: string) =>
  load((api) => unwrap(ws(api)["token-actions"].$get({ param: { slug } })));

/** Audit log of token use of those actions (owners and admins, sessions only). */
export const getTokenActionLog = (slug: string, query: { limit?: string; offset?: string } = {}) =>
  load((api) => unwrap(ws(api)["token-actions"].log.$get({ param: { slug }, query })));

export type CalendarData = Awaited<ReturnType<typeof getCalendar>>;
export type Meeting = CalendarData["meetings"][number];
export type PersonalEvent = CalendarData["events"][number];
export type CalendarConnection = Awaited<ReturnType<typeof getCalendarConnections>>["connections"][number];

export type ApiToken = Awaited<ReturnType<typeof getApiTokens>>["apiTokens"][number];

/** The signed-in person's assistant provider keys (provider and last four characters only) and preferences (sessions only). */
export const getAssistantKeys = () => load((api) => unwrap(api.v1.me.assistant.keys.$get()));
export const getAssistantSettings = () => load((api) => unwrap(api.v1.me.assistant.settings.$get()));
export type AssistantKey = Awaited<ReturnType<typeof getAssistantKeys>>["keys"][number];
export type AssistantSettings = Awaited<ReturnType<typeof getAssistantSettings>>["settings"];

export type NotificationsPage = Awaited<ReturnType<typeof getNotifications>>;
export type Notification = NotificationsPage["notifications"][number];

export type TimeReport = Awaited<ReturnType<typeof getTimeReport>>;
export type Me = Awaited<ReturnType<typeof getMe>>;
export type Bootstrap = Awaited<ReturnType<typeof getBootstrap>>;
export type TaskSummary = Bootstrap["tasks"][number];
/** A dependency: `blockingTaskId` blocks `blockedTaskId`. */
export type TaskRelation = Bootstrap["taskRelations"][number];
export type TaskDetail = Awaited<ReturnType<typeof getTask>>;
export type TaskComment = Awaited<ReturnType<typeof getTaskComments>>["comments"][number];
export type TaskAttachment = Awaited<ReturnType<typeof getTaskAttachments>>["attachments"][number];
export type WorkflowState = Bootstrap["workflowStates"][number];
export type Team = Bootstrap["teams"][number];
export type Item = Awaited<ReturnType<typeof getItems>>["items"][number];
export type RecipeRow = Awaited<ReturnType<typeof getRecipes>>["recipes"][number];
export type Recipe = Awaited<ReturnType<typeof getRecipe>>;
export type RecipeVersion = NonNullable<Recipe["currentVersion"]>;
export type Supplier = Awaited<ReturnType<typeof getSuppliers>>["suppliers"][number];
export type SpecificationRow = Awaited<ReturnType<typeof getSpecifications>>["specifications"][number];
export type Specification = Awaited<ReturnType<typeof getSpecification>>;
export type SpecificationVersion = NonNullable<Specification["approvedVersion"]>;
export type SpecificationImpact = Awaited<ReturnType<typeof getSpecificationImpact>>;
export type TestSampleRow = Awaited<ReturnType<typeof getTestSamples>>["samples"][number];
export type TestSample = Awaited<ReturnType<typeof getTestSample>>;
export type TestPlan = Awaited<ReturnType<typeof getTestPlans>>["plans"][number];
export type TestLaboratory = Awaited<ReturnType<typeof getTestLaboratories>>["laboratories"][number];
export type SamplingPoint = Awaited<ReturnType<typeof getSamplingPoints>>["points"][number];
export type TestTrend = Awaited<ReturnType<typeof getTestTrend>>;
export type LotReleaseCheck = Awaited<ReturnType<typeof getLotReleaseCheck>>;
export type LotRelease = Awaited<ReturnType<typeof getLotReleases>>["releases"][number];
export type LotReleaseExceptionRequest = Awaited<
  ReturnType<typeof getLotReleaseExceptions>
>["requests"][number];
export type NpdProjectRow = Awaited<ReturnType<typeof getNpdProjects>>["projects"][number];
export type NpdProject = Awaited<ReturnType<typeof getNpdProject>>;
export type DefenceOverview = Awaited<ReturnType<typeof getDefenceOverview>>;
export type DefenceAssessmentRow = Awaited<ReturnType<typeof getDefenceAssessments>>["assessments"][number];
export type DefenceAssessment = Awaited<ReturnType<typeof getDefenceAssessment>>;
export type DefenceControlRow = Awaited<ReturnType<typeof getDefenceControls>>["controls"][number];
export type DefenceCheckRow = Awaited<ReturnType<typeof getDefenceChecks>>["checks"][number];
export type GovernanceOverview = Awaited<ReturnType<typeof getGovernanceOverview>>;
export type GovernanceObjective = Awaited<ReturnType<typeof getGovernanceObjectives>>["objectives"][number];
export type GovernanceCultureActivity = Awaited<
  ReturnType<typeof getGovernanceCulture>
>["activities"][number];
export type GovernanceRequirement = Awaited<
  ReturnType<typeof getGovernanceRequirements>
>["requirements"][number];
export type GovernanceConcern = Awaited<ReturnType<typeof getGovernanceConcerns>>["concerns"][number];
export type ManagementReviewRow = Awaited<ReturnType<typeof getManagementReviews>>["reviews"][number];
export type ManagementReview = Awaited<ReturnType<typeof getManagementReview>>;
export type MyConcern = Awaited<ReturnType<typeof getMyConcerns>>["concerns"][number];
export type DefenceExerciseRow = Awaited<ReturnType<typeof getDefenceExercises>>["exercises"][number];
export type SupplierControls = Awaited<ReturnType<typeof getSupplierControls>>;
export type SupplierDetail = Awaited<ReturnType<typeof getSupplier>>;
export type ReleaseRuleRow = Awaited<ReturnType<typeof getReleaseRules>>["rules"][number];
export type SopRow = Awaited<ReturnType<typeof getSops>>["sops"][number];
export type SopDetail = Awaited<ReturnType<typeof getSop>>;
export type SopTargets = Awaited<ReturnType<typeof getSopTargets>>;
export type SopCopyRow = Awaited<ReturnType<typeof getSopCopies>>["copies"][number];
export type SopOutstanding = Awaited<ReturnType<typeof getSopOutstanding>>;
export type SopAcknowledgements = Awaited<ReturnType<typeof getSopAcknowledgements>>;
export type StaffMember = Awaited<ReturnType<typeof getStaffList>>["staff"][number];
export type JobRole = Awaited<ReturnType<typeof getJobRoles>>["jobRoles"][number];
export type TrainingCourse = Awaited<ReturnType<typeof getTrainingCourses>>["courses"][number];
export type TrainingMatrix = Awaited<ReturnType<typeof getTrainingMatrix>>;
export type TrainingDueItem = Awaited<ReturnType<typeof getTrainingDue>>["items"][number];
export type TrainingRecord = Awaited<ReturnType<typeof getPendingSignOffs>>["records"][number];
export type StaffTraining = Awaited<ReturnType<typeof getStaffTraining>>;
export type OnSite = Awaited<ReturnType<typeof getOnSite>>;
export type RollCallSummary = Awaited<ReturnType<typeof getRollCalls>>["rollCalls"][number];
export type RollCall = Awaited<ReturnType<typeof getRollCall>>;
export type ShiftsReport = Awaited<ReturnType<typeof getShifts>>;
export type PayrollPreview = Awaited<ReturnType<typeof getPayrollPreview>>;
export type Visit = Awaited<ReturnType<typeof getVisits>>["visits"][number];
export type KioskDevice = Awaited<ReturnType<typeof getKioskDevices>>["devices"][number];
export type KioskBadgeRow = Awaited<ReturnType<typeof getKioskBadges>>["people"][number];
export type KioskRejection = Awaited<ReturnType<typeof getKioskRejections>>["rejections"][number];
export type StockLevel = Awaited<ReturnType<typeof getStockLevels>>["levels"][number];
export type StockLocation = Awaited<ReturnType<typeof getStockLocations>>["locations"][number];
export type StockLot = Awaited<ReturnType<typeof getStockLots>>["lots"][number];
export type QualitySummary = Awaited<ReturnType<typeof getQualitySummary>>;
export type ComplaintRow = Awaited<ReturnType<typeof getComplaints>>["complaints"][number];
export type ComplaintDetail = Awaited<ReturnType<typeof getComplaint>>;
export type NonconformanceRow = Awaited<ReturnType<typeof getNonconformances>>["nonconformances"][number];
export type QualityAuditRow = Awaited<ReturnType<typeof getAudits>>["audits"][number];
export type QualityAuditDetail = Awaited<ReturnType<typeof getAudit>>;
export type AuditProgrammeRow = Awaited<ReturnType<typeof getAuditProgrammes>>["programmes"][number];
export type ComplaintTrends = Awaited<ReturnType<typeof getComplaintTrends>>;
export type SupplierQuality = Awaited<ReturnType<typeof getSupplierQuality>>;
export type RecallTestRow = Awaited<ReturnType<typeof getRecallTests>>["recallTests"][number];
export type PurchaseOrderRow = Awaited<ReturnType<typeof getPurchaseOrders>>["orders"][number];
export type PurchaseOrderDetail = Awaited<ReturnType<typeof getPurchaseOrder>>;
export type PurchaseOrderLine = PurchaseOrderDetail["lines"][number];
export type PurchaseInvoiceRow = Awaited<ReturnType<typeof getPurchaseInvoices>>["invoices"][number];
export type PurchaseInvoiceDetail = Awaited<ReturnType<typeof getPurchaseInvoice>>;
export type SupplierPriceRow = Awaited<ReturnType<typeof getSupplierPrices>>["prices"][number];
export type PurchaseCreditNoteRow = Awaited<ReturnType<typeof getPurchaseCreditNotes>>["creditNotes"][number];
export type PurchaseCreditNoteDetail = Awaited<ReturnType<typeof getPurchaseCreditNote>>;
export type PurchaseInvoiceLine = PurchaseInvoiceDetail["lines"][number];
export type PurchaseDelivery = PurchaseOrderDetail["deliveries"][number];
export type PurchaseDeliveryReceipt = PurchaseDelivery["receipts"][number];
export type PurchaseSuggestions = NonNullable<Awaited<ReturnType<typeof getPurchaseSuggestions>>["data"]>;
export type PurchaseSuggestion = PurchaseSuggestions["covered"][number];
export type SupplierPerformanceReport = Awaited<ReturnType<typeof getSupplierPerformance>>;
export type BatchCostRow = Awaited<ReturnType<typeof getBatchCosts>>["batches"][number];
export type BatchCostDetail = Awaited<ReturnType<typeof getBatchCost>>;
export type CostingReportData = NonNullable<Awaited<ReturnType<typeof getCostingReport>>["data"]>;
export type ProductLabelRow = Awaited<ReturnType<typeof getProductLabels>>["labels"][number];
export type ProductLabelDetail = Awaited<ReturnType<typeof getProductLabel>>;
export type LabellingItem = Awaited<ReturnType<typeof getLabellingItems>>["items"][number];
export type StockLotDetail = Awaited<ReturnType<typeof getStockLot>>;
export type DemandSummaryData = Awaited<ReturnType<typeof getDemandSummary>>;
export type DemandForecastData = DemandForecast;
export type DemandCapacityData = Awaited<ReturnType<typeof getDemandCapacity>>;
export type DemandCoverageData = Awaited<ReturnType<typeof getDemandCoverage>>;
export type DemandPackUnit = Awaited<ReturnType<typeof getDemandPackUnits>>["packUnits"][number];
export type DemandLine = Awaited<ReturnType<typeof getDemandLines>>["lines"][number];
export type DemandImport = Awaited<ReturnType<typeof getDemandImports>>["imports"][number];
export type ProductionBatch = Awaited<ReturnType<typeof getProductionBatches>>["batches"][number];
export type ProductionLine = Awaited<ReturnType<typeof getProductionLines>>["lines"][number];
export type ProductionSchedule = Awaited<ReturnType<typeof getProductionSchedule>>;
export type ProductionDayPlan = Awaited<ReturnType<typeof getProductionDayPlan>>;
export type ProductionDailyDemand = Awaited<ReturnType<typeof getProductionDailyDemand>>;
export type ProductionPerformance = Awaited<ReturnType<typeof getProductionPerformance>>;
export type ProductionDowntimeList = Awaited<ReturnType<typeof getProductionDowntime>>;
export type BatchPerformance = Awaited<ReturnType<typeof getBatchPerformance>>;
export type BatchPacking = Awaited<ReturnType<typeof getBatchPacking>>;
export type StandardSummary = Awaited<ReturnType<typeof getStandards>>["standards"][number];
export type GapAnalysis = Awaited<ReturnType<typeof getGapAnalysis>>;
export type GapSnapshotSummary = Awaited<ReturnType<typeof getGapSnapshots>>["snapshots"][number];
export type GapSnapshot = Awaited<ReturnType<typeof getGapSnapshot>>;
export type ProductionDevice = Awaited<ReturnType<typeof getProductionDevices>>["devices"][number];
export type LotReservation = Awaited<ReturnType<typeof getLotReservations>>["reservations"][number];
export type ProductionBatchDetail = Awaited<ReturnType<typeof getProductionBatch>>;
export type MaterialRequirements = Awaited<ReturnType<typeof getMaterialRequirements>>;
export type PlanFromDemand = Awaited<ReturnType<typeof getPlanFromDemand>>;
export type LotTrace = Awaited<ReturnType<typeof getLotTrace>>;
export type HaccpPlanRow = Awaited<ReturnType<typeof getHaccpPlans>>["plans"][number];
export type HaccpPlan = Awaited<ReturnType<typeof getHaccpPlan>>;
export type HaccpLibraryEntry = Awaited<ReturnType<typeof getHaccpLibrary>>["entries"][number];
export type HaccpTemplate = Awaited<ReturnType<typeof getHaccpTemplates>>["templates"][number];
export type HaccpPlanVersion = Awaited<ReturnType<typeof getHaccpPlanVersion>>;
export type HaccpCcp = HaccpPlanVersion["ccps"][number];
export type HaccpDue = Awaited<ReturnType<typeof getHaccpDue>>;
export type HaccpDueCheck = HaccpDue["checks"][number];
export type HaccpLog = Awaited<ReturnType<typeof getHaccpLogs>>["logs"][number];
export type CorrectiveAction = Awaited<ReturnType<typeof getCorrectiveActions>>["correctiveActions"][number];
export type HaccpAsset = Awaited<ReturnType<typeof getHaccpAssets>>["assets"][number];
export type CleaningRecord = Awaited<ReturnType<typeof getCleaningRecords>>["records"][number];
export type CalibrationRecord = Awaited<ReturnType<typeof getCalibrationRecords>>["records"][number];
export type HaccpBatchRecord = Awaited<ReturnType<typeof getHaccpBatchRecord>>;
export type SiteDue = Awaited<ReturnType<typeof getSiteDue>>;
export type SiteDueItem = SiteDue["items"][number];
export type SiteArea = Awaited<ReturnType<typeof getSiteAreas>>["areas"][number];
export type PestDevice = Awaited<ReturnType<typeof getPestDevices>>["devices"][number];
export type PestVisit = Awaited<ReturnType<typeof getPestVisits>>["visits"][number];
export type PestTrends = Awaited<ReturnType<typeof getPestTrends>>;
export type PestTrendSeriesRow = PestTrends["series"][number];
export type CalibrationInstrument = Awaited<
  ReturnType<typeof getCalibrationInstruments>
>["instruments"][number];
export type WorkOrder = Awaited<ReturnType<typeof getWorkOrders>>["workOrders"][number];
export type GlassItem = Awaited<ReturnType<typeof getGlassItems>>["items"][number];
export type GlassBreakage = Awaited<ReturnType<typeof getGlassBreakages>>["breakages"][number];
export type GlassCheck = Awaited<ReturnType<typeof getSiteAuditRecords>>["glassChecks"][number];
export type MaintenanceAsset = Awaited<ReturnType<typeof getMaintenanceAssets>>["assets"][number];
export type MaintenanceTask = Awaited<ReturnType<typeof getMaintenanceTasks>>["tasks"][number];
export type MaintenanceRecord = Awaited<ReturnType<typeof getMaintenanceRecords>>["records"][number];
export type StorageUnit = Awaited<ReturnType<typeof getStorageUnits>>["units"][number];
export type StorageReading = Awaited<ReturnType<typeof getStorageReadings>>["readings"][number];
export type SiteAction = Awaited<ReturnType<typeof getSiteActions>>["actions"][number];
export type ChecklistTemplate = Awaited<ReturnType<typeof getChecklistTemplates>>["templates"][number];
export type ChecklistCheck = Awaited<ReturnType<typeof getChecklistChecks>>["checks"][number];
export type TokenActions = Awaited<ReturnType<typeof getTokenActions>>;
export type TokenActionItem = TokenActions["actions"][number];
export type PersonOnlyItem = TokenActions["personOnly"][number];
export type TokenActionLog = Awaited<ReturnType<typeof getTokenActionLog>>;
export type TokenActionLogEntry = TokenActionLog["entries"][number];
export type ModuleAccess = Awaited<ReturnType<typeof getModuleAccess>>;
export type Member = Awaited<ReturnType<typeof getMembers>>["members"][number];
export type Invitation = Awaited<ReturnType<typeof getInvitations>>["invitations"][number];
export type Label = Bootstrap["labels"][number];
export type DocumentMeta = Bootstrap["documents"][number];
export type ProjectWithProgress = Awaited<ReturnType<typeof getProjects>>["projects"][number];

// ─── Print and audit pages ───────────────────────────────────────────────────

/** Every row of a paged list (`size` per request), up to `cap` rows so a print stays printable. */
async function allPages<T>(
  page: (offset: number, size: number) => Promise<{ rows: T[]; total: number }>,
  size = 200,
  cap = 2000,
): Promise<{ rows: T[]; total: number }> {
  const first = await page(0, size);
  const rows = [...first.rows];
  while (rows.length < Math.min(first.total, cap)) {
    const next = await page(rows.length, size);
    if (next.rows.length === 0) break;
    rows.push(...next.rows);
  }
  return { rows: rows.slice(0, cap), total: first.total };
}

/** A HACCP plan's CCP checks between two days (corrected readings included, marked), oldest first. */
export const getHaccpAuditLogs = (slug: string, planId: string, range: { from: string; to: string }) =>
  load(async (api) => {
    const { rows, total } = await allPages(async (offset, size) => {
      const r = await unwrap(
        ws(api).haccp.logs.$get({
          param: { slug },
          query: { planId, ...range, includeCorrected: "true", limit: String(size), offset: String(offset) },
        }),
      );
      return { rows: r.logs, total: r.total };
    });
    return { logs: rows.reverse(), total };
  });

/** A plan's daily sign-offs, newest first (optionally between two days). */
export const getHaccpSignoffs = (slug: string, planId: string, range?: { from: string; to: string }) =>
  load((api) =>
    unwrap(
      ws(api).haccp.signoffs.$get({
        param: { slug },
        query: { planId, ...(range ?? {}), limit: "200" },
      }),
    ),
  );
export type HaccpSignoff = Awaited<ReturnType<typeof getHaccpSignoffs>>["signoffs"][number];

/** Cleaning and calibration records between two days (all areas and equipment), oldest first. */
export const getHaccpAuditAssetRecords = (slug: string, range: { from: string; to: string }) =>
  load(async (api) => {
    const query = (offset: number, size: number) => ({
      ...range,
      limit: String(size),
      offset: String(offset),
    });
    const [cleaning, calibration] = await Promise.all([
      allPages(async (offset, size) => {
        const r = await unwrap(ws(api).haccp.cleaning.$get({ param: { slug }, query: query(offset, size) }));
        return { rows: r.records, total: r.total };
      }),
      allPages(async (offset, size) => {
        const r = await unwrap(
          ws(api).haccp.calibration.$get({ param: { slug }, query: query(offset, size) }),
        );
        return { rows: r.records, total: r.total };
      }),
    ]);
    return {
      cleaning: cleaning.rows.reverse(),
      cleaningTotal: cleaning.total,
      calibration: calibration.rows.reverse(),
      calibrationTotal: calibration.total,
    };
  });

/** Every corrective action (open and closed), newest first; the audit page picks the plan's. */
export const getAllCorrectiveActions = (slug: string) =>
  load(async (api) => {
    const { rows } = await allPages(async (offset, size) => {
      const r = await unwrap(
        ws(api).haccp["corrective-actions"].$get({
          param: { slug },
          query: { status: "all", limit: String(size), offset: String(offset) },
        }),
      );
      return { rows: r.correctiveActions, total: r.total };
    });
    return rows;
  });

/** The site programmes' records between two days: readings, checks, maintenance and pest visits. */
export const getSiteAuditRecords = (slug: string, range: { from: string; to: string }) =>
  load(async (api) => {
    const site = ws(api).site;
    const query = (offset: number, size: number) => ({
      ...range,
      includeCorrected: "true" as const,
      limit: String(size),
      offset: String(offset),
    });
    const [readings, checks, maintenance, visits, glassChecks, breakages] = await Promise.all([
      allPages(async (o, s) => {
        const r = await unwrap(site.storage.readings.$get({ param: { slug }, query: query(o, s) }));
        return { rows: r.readings, total: r.total };
      }),
      allPages(async (o, s) => {
        const r = await unwrap(site.checklists.checks.$get({ param: { slug }, query: query(o, s) }));
        return { rows: r.checks, total: r.total };
      }),
      allPages(async (o, s) => {
        const r = await unwrap(site.maintenance.records.$get({ param: { slug }, query: query(o, s) }));
        return { rows: r.records, total: r.total };
      }),
      allPages(async (o, s) => {
        const r = await unwrap(site.pest.visits.$get({ param: { slug }, query: query(o, s) }));
        return { rows: r.visits, total: r.total };
      }),
      allPages(async (o, s) => {
        const r = await unwrap(site.glass.checks.$get({ param: { slug }, query: query(o, s) }));
        return { rows: r.checks, total: r.total };
      }),
      allPages(async (o, s) => {
        const r = await unwrap(
          site.glass.breakages.$get({
            param: { slug },
            query: { ...range, status: "all", limit: String(s), offset: String(o) },
          }),
        );
        return { rows: r.breakages, total: r.total };
      }),
    ]);
    return {
      readings: readings.rows.reverse(),
      checks: checks.rows.reverse(),
      maintenance: maintenance.rows.reverse(),
      visits: visits.rows.reverse(),
      glassChecks: glassChecks.rows.reverse(),
      breakages: breakages.rows.reverse(),
      truncated: [readings, checks, maintenance, visits, glassChecks, breakages].some(
        (p) => p.total > p.rows.length,
      ),
    };
  });

/** Every internal audit and mock recall test (voided included), for the quality records print. */
export const getQualityAuditRecords = (slug: string) =>
  load(async (api) => {
    const q = ws(api).quality;
    const [audits, recalls] = await Promise.all([
      unwrap(q.audits.$get({ param: { slug }, query: { status: "all", limit: "200" } })),
      unwrap(q["recall-tests"].$get({ param: { slug }, query: { includeVoided: "true", limit: "200" } })),
    ]);
    return { audits: audits.audits, recallTests: recalls.recallTests };
  });

/** Current, permission-filtered food-safety readiness. Sign-off remains advisory. */
export const getProductionReadiness = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).production.batches[":id"].readiness.$get({ param: { slug, id } })));

export const getIncidents = (slug: string, offset = "0") =>
  load((api) => unwrap(ws(api).quality.incidents.$get({ param: { slug }, query: { offset } })));
export const getIncident = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).quality.incidents[":id"].$get({ param: { slug, id } })));

export const getDeliverySites = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).customers[":id"].sites.$get({ param: { slug, id } })));
export const getCustomer = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).customers[":id"].$get({ param: { slug, id } })));
export const getDespatchOperations = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).despatch[":id"].operations.$get({ param: { slug, id } })));

export const getAuthenticityAssessments = (
  slug: string,
  query: {
    q?: string;
    itemId?: string;
    supplierId?: string;
    state?: "all" | "active" | "needs_review" | "overdue_controls" | "archived";
    offset?: string;
  } = {},
) => load((api) => unwrap(ws(api).quality.authenticity.$get({ param: { slug }, query })));
export const getAuthenticityAssessment = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).quality.authenticity[":id"].$get({ param: { slug, id } })));

export const getSalesOrders = (
  slug: string,
  query: {
    kind?: "quote" | "order";
    status?: "draft" | "issued" | "confirmed" | "cancelled";
    offset?: string;
  } = {},
) => load((api) => unwrap(ws(api).sales.orders.$get({ param: { slug }, query })));
export const getSalesOrder = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).sales.orders[":id"].$get({ param: { slug, id } })));
export const getSalesHistory = (slug: string, id: string, offset = "0") =>
  load((api) =>
    unwrap(ws(api).sales.orders[":id"].history.$get({ param: { slug, id }, query: { limit: "10", offset } })),
  );
export const getSalesPrices = (slug: string, offset = "0") =>
  load((api) => unwrap(ws(api).sales.prices.$get({ param: { slug }, query: { offset } })));
export const getSalesFulfilments = (slug: string, id: string, offset = "0") =>
  load((api) =>
    unwrap(ws(api).sales.orders[":id"].fulfilments.$get({ param: { slug, id }, query: { offset } })),
  );
export const getSalesCommitments = (slug: string, query: { from: string; to: string; offset?: string }) =>
  load((api) => unwrap(ws(api).sales.commitments.$get({ param: { slug }, query })));
export const getSalesIntegration = (slug: string, offset = "0") =>
  load((api) => unwrap(ws(api).sales.integration.$get({ param: { slug }, query: { offset } })));
export type SalesOrder = Awaited<ReturnType<typeof getSalesOrder>>;
export type SalesPrice = Awaited<ReturnType<typeof getSalesPrices>>["prices"][number];
export type SalesFulfilments = Awaited<ReturnType<typeof getSalesFulfilments>>;

export const getHseRecords = (
  slug: string,
  query: { kind?: import("@knotworking/core").HseKind; status?: "active" | "archived"; offset?: string } = {},
) => load((api) => unwrap(ws(api).hse.registers.$get({ param: { slug }, query })));
export const getHseRecord = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).hse.registers[":id"].$get({ param: { slug, id } })));
export const getHseHistory = (slug: string, id: string, offset = "0") =>
  load((api) =>
    unwrap(
      ws(api).hse.registers[":id"].history.$get({ param: { slug, id }, query: { limit: "10", offset } }),
    ),
  );
export const getHseEntries = (slug: string, id: string, offset = "0") =>
  load((api) =>
    unwrap(ws(api).hse.registers[":id"].entries.$get({ param: { slug, id }, query: { offset } })),
  );
export const getHsePermits = (slug: string, offset = "0") =>
  load((api) => unwrap(ws(api).hse.permits.$get({ param: { slug }, query: { offset } })));
export const getHsePermit = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).hse.permits[":id"].$get({ param: { slug, id } })));
export const getHsePermitHistory = (slug: string, id: string, offset = "0") =>
  load((api) =>
    unwrap(ws(api).hse.permits[":id"].history.$get({ param: { slug, id }, query: { limit: "10", offset } })),
  );
export const getHseIncidents = (slug: string, offset = "0") =>
  load((api) => unwrap(ws(api).hse.incidents.$get({ param: { slug }, query: { offset } })));
export const getHseIncident = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).hse.incidents[":id"].$get({ param: { slug, id } })));
export const getHseIncidentHistory = (slug: string, id: string, offset = "0") =>
  load((api) =>
    unwrap(
      ws(api).hse.incidents[":id"].history.$get({ param: { slug, id }, query: { limit: "10", offset } }),
    ),
  );
/** Restricted incidents: open ones, pending reporting decisions, overdue actions, days since lost time. */
export const getHseIncidentOverview = (slug: string) =>
  load((api) => unwrap(ws(api).hse.incidents.overview.$get({ param: { slug } })));
export type HseIncidentOverview = Awaited<ReturnType<typeof getHseIncidentOverview>>;
export type HseRecord = Awaited<ReturnType<typeof getHseRecord>>;
export type HsePermit = Awaited<ReturnType<typeof getHsePermit>>;
export type HseIncident = Awaited<ReturnType<typeof getHseIncident>>;
export type HseEntryRow = Awaited<ReturnType<typeof getHseEntries>>["entries"][number];

export const getAccountingConnections = (slug: string, offset = "0") =>
  load((api) => unwrap(ws(api).accounting.connections.$get({ param: { slug }, query: { offset } })));

export const getMyAbsences = (slug: string, offset = "0") =>
  load((api) => unwrap(ws(api).workforce.me.$get({ param: { slug }, query: { offset } })));
export const getHrAbsences = (slug: string, offset = "0") =>
  load((api) => unwrap(ws(api).workforce.hr.absences.$get({ param: { slug }, query: { offset } })));

/** Dashboards (`bi`): the ones the viewer may open, newest first. */
export const getDashboards = (
  slug: string,
  query: { scope?: string; archived?: "true" | "false"; template?: "true" | "false" } = {},
) => load((api) => unwrap(ws(api).bi.dashboards.$get({ param: { slug }, query })));
/** The datasets, fields and measures the viewer may build from. */
export const getBiDatasets = (slug: string) =>
  load((api) => unwrap(ws(api).bi.datasets.$get({ param: { slug } })));
export type BiCatalogueAnswer = Awaited<ReturnType<typeof getBiDatasets>>;
/** Board snapshots (managers) and packs (managers, and the audience of issued ones). */
export const getSnapshots = (
  slug: string,
  query: { dashboardId?: string; kind?: "dashboard" | "analysis" } = {},
) => load((api) => unwrap(ws(api).bi.snapshots.$get({ param: { slug }, query })));
export const getSnapshot = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).bi.snapshots[":id"].$get({ param: { slug, id } })));
export const getPacks = (slug: string) => load((api) => unwrap(ws(api).bi.packs.$get({ param: { slug } })));
export const getPack = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).bi.packs[":id"].$get({ param: { slug, id } })));
export type SnapshotDetail = Awaited<ReturnType<typeof getSnapshot>>;
export type SnapshotSummary = Awaited<ReturnType<typeof getSnapshots>>["snapshots"][number];
export type PackSummary = Awaited<ReturnType<typeof getPacks>>["packs"][number];
export type PackDetail = Awaited<ReturnType<typeof getPack>>;
export const getDashboard = (slug: string, id: string) =>
  load((api) => unwrap(ws(api).bi.dashboards[":id"].$get({ param: { slug, id } })));
/** Every widget's data as the viewer, with the view's period and filter values (JSON in `params`). */
export const getDashboardData = (slug: string, id: string, params?: string) =>
  load((api) =>
    unwrap(ws(api).bi.dashboards[":id"].data.$get({ param: { slug, id }, query: params ? { params } : {} })),
  );
export type DashboardSummary = Awaited<ReturnType<typeof getDashboards>>["dashboards"][number];
export type DashboardDetail = Awaited<ReturnType<typeof getDashboard>>;
