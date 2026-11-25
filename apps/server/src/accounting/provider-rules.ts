import type { AccountingPosting } from "@knotworking/core";
import { xeroDocumentIssues } from "./adapters/xero";

type DocumentFields = Pick<AccountingPosting, "kind" | "date" | "reference" | "currency"> & {
  dueDate?: string | null;
  /** Null while the supplier has no reviewed mapping: that is reported separately. */
  supplierReference: string | null;
};

/**
 * Checks an installed provider needs before a document can be prepared for it, so the reviewer
 * fixes the source instead of queueing a posting the adapter will refuse. Each adapter repeats its
 * own checks before sending. Providers without rules here accept any valid shared posting.
 */
const rules: Record<string, (document: DocumentFields) => string[]> = {
  xero: xeroDocumentIssues,
};

export function providerDocumentIssues(provider: string, document: DocumentFields): string[] {
  return Object.hasOwn(rules, provider) ? rules[provider]!(document) : [];
}
