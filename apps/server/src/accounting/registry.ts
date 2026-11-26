import type { AccountingPosting, AccountingReceipt } from "@knotworking/core";
import type { AccountingAdapter, AccountingAllocationResult } from "./adapter";

/** The configured destination an adapter is built for. */
export interface AccountingBinding {
  workspaceId: string;
  workspaceSlug: string;
  /** The workspace currency (invoices are prepared in it). */
  currency: string;
  connectionId: string;
  provider: string;
  companyId: string;
}

/**
 * An adapter, optionally able to read a known transaction back from the destination ledger. Read-back
 * is how an uncertain posting is positively reconciled; a null result is never proof of no write.
 */
export type InstalledAccountingAdapter = AccountingAdapter & {
  /** Current destination coding, if available. Sending performs its own fresh validation. */
  customerCoding?(): Promise<{
    revenueAccounts: Set<string>;
    taxRates: Map<string, number>;
  } | null>;
  /** Search for a committed write when the destination ID was lost with the response. */
  findExisting?(input: {
    postingKey: string;
    document: AccountingPosting;
  }): Promise<AccountingReceipt | null>;
  /**
   * Reads a posted credit back and finishes its requested allocation if it is not there yet. Never
   * throws; `allocated: false` leaves the allocation pending with the evidence shown to finance.
   */
  allocate?(input: {
    postingKey: string;
    document: AccountingPosting;
    externalId: string;
  }): Promise<AccountingAllocationResult>;
  readBack?(input: {
    postingKey: string;
    document: AccountingPosting;
    externalId: string;
  }): Promise<AccountingReceipt | null>;
};

/**
 * Builds the adapter for one connection, or null when this installation can't (no credentials yet,
 * an unsupported company). Factories run on the server only and hold credentials themselves.
 */
export type AccountingAdapterFactory = (
  binding: AccountingBinding,
) => InstalledAccountingAdapter | null | Promise<InstalledAccountingAdapter | null>;

export interface AccountingAdapterRegistry {
  /** Provider IDs with an installed factory. */
  readonly providers: readonly string[];
  resolve(binding: AccountingBinding): Promise<InstalledAccountingAdapter | null>;
}

/**
 * The adapters installed in this API process, by provider ID. Empty by default: saving a connection
 * never sends anything until an adapter with real credentials is registered here. A factory that
 * returns an adapter bound to another destination is ignored rather than trusted.
 */
export function createAccountingAdapterRegistry(
  factories: Record<string, AccountingAdapterFactory> = {},
): AccountingAdapterRegistry {
  return {
    providers: Object.keys(factories),
    async resolve(binding) {
      const factory = Object.hasOwn(factories, binding.provider) ? factories[binding.provider] : undefined;
      if (!factory || !binding.companyId) return null;
      const adapter = await factory(binding);
      if (
        !adapter ||
        adapter.provider !== binding.provider ||
        adapter.connectionId !== binding.connectionId ||
        adapter.companyId !== binding.companyId
      )
        return null;
      return adapter;
    },
  };
}
