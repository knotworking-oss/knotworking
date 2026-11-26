import { xeroDocumentIssues } from "./adapters/xero";

type DocumentFields = Parameters<typeof xeroDocumentIssues>[0];

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
