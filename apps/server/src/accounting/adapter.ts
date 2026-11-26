import type { AccountingPosting, AccountingReceipt } from "@knotworking/core";

/** An adapter instance is bound to one configured destination. Credentials and SDK objects
 * stay in the implementation; the shared queue knows only canonical accounting documents.
 * Implementations may use a cloud API, a local bridge, or a verified file exchange.
 */
export interface AccountingAdapter {
  readonly provider: string;
  readonly connectionId: string;
  readonly companyId: string;
  readonly capabilities: {
    readonly postingKinds: readonly AccountingPosting["kind"][];
    readonly currencies: readonly string[];
  };
  post(input: {
    postingKey: string;
    idempotencyKey?: string;
    attemptId: string;
    document: AccountingPosting;
  }): Promise<
    | { outcome: "posted"; receipt: AccountingReceipt }
    // Only return rejected if the destination definitively performed NO write.
    | { outcome: "rejected"; evidence: string }
    | { outcome: "unknown"; evidence: string }
    // Only if NO write happened and sending later may succeed without anyone acting (a rate
    // limit, a setup waiting to be reconnected): the posting returns to the queue.
    | { outcome: "deferred"; evidence: string }
  >;
}
