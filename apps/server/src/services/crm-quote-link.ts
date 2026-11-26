import { crmOpportunities, type Executor } from "@knotworking/db";
import { and, eq } from "drizzle-orm";
import { ApiError } from "../errors";

/**
 * A Sales or Client services quote that backs a CRM opportunity keeps that opportunity's customer:
 * moving it to another customer would hand the deal off to someone else's order or project. The
 * link is unlinked (or another quote linked) in CRM first; a fresh quote serves the other customer.
 * Checked whether or not CRM is switched on, since its saved links come back with it.
 */
export async function assertNoCrmLinkOnCustomerChange(
  db: Executor,
  workspaceId: string,
  kind: "sales" | "service",
  quoteId: string,
) {
  const column = kind === "sales" ? crmOpportunities.salesQuoteId : crmOpportunities.serviceQuoteId;
  const [linked] = await db
    .select({ reference: crmOpportunities.reference })
    .from(crmOpportunities)
    .where(and(eq(crmOpportunities.workspaceId, workspaceId), eq(column, quoteId)))
    .limit(1);
  if (linked)
    throw new ApiError(
      409,
      "quote_linked_to_crm",
      `This quote backs CRM opportunity ${linked.reference}, so its customer can't change. Unlink it in CRM first, or draft a new quote for the other customer`,
    );
}
