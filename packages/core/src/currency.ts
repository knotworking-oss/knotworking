import { z } from "zod";

/**
 * The workspace currency: an ISO 4217 code every cost and price in the workspace is in (`GBP`
 * until an owner or admin changes it). Amounts are plain numbers everywhere (items' standard
 * costs, purchase prices, costing); the currency only decides how they are shown, so changing it
 * converts nothing. `Intl` only, no DOM or Node APIs, so server, web, desktop and mobile share it.
 */
export const DEFAULT_CURRENCY = "GBP";

/** Used where `Intl` can't list currencies (very old runtimes). */
const FALLBACK_CURRENCIES = ["GBP", "EUR", "USD", "AUD", "CAD", "CHF", "DKK", "NOK", "NZD", "PLN", "SEK"];

let supported: Set<string> | null = null;

/** ISO 4217 codes this runtime knows (`Intl.supportedValuesOf("currency")`), sorted. */
export function supportedCurrencies(): string[] {
  const list =
    typeof Intl.supportedValuesOf === "function"
      ? (Intl.supportedValuesOf("currency") as string[])
      : FALLBACK_CURRENCIES;
  return list.length ? list : FALLBACK_CURRENCIES;
}

/** Whether `code` is a known ISO 4217 code in upper case. */
export function isSupportedCurrency(code: string): boolean {
  supported ??= new Set(supportedCurrencies());
  return supported.has(code);
}

/** An ISO 4217 code (`GBP`), accepted in any case and stored upper case. */
export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Use a three-letter ISO 4217 code such as GBP")
  .refine(isSupportedCurrency, "Unknown currency: use an ISO 4217 code such as GBP");

/** The currency to use for a stored value: itself when valid, else the default. */
export function effectiveCurrency(stored: string | null | undefined): string {
  const parsed = currencySchema.safeParse(stored ?? DEFAULT_CURRENCY);
  return parsed.success ? parsed.data : DEFAULT_CURRENCY;
}

/** How many decimal places a currency normally has (2 for GBP, 0 for JPY). */
export function currencyDigits(currency: string): number {
  return (
    new Intl.NumberFormat("en-GB", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ??
    2
  );
}

export interface MoneyFormatOptions {
  /** The most decimal places shown (default 4, enough for a per-kg cost; a per-gram price needs 8). */
  maxDecimals?: number;
}

const formatters = new Map<string, Intl.NumberFormat>();

/**
 * An amount in a currency as people in the UK read it: `£1,234.50`, `€0.35`, `-£2.10`. At least
 * the currency's own decimals (2 for pounds) and up to `maxDecimals` where the figure needs them,
 * so a price of 0.00345 is not rounded to nothing (`{ maxDecimals: 8 }` for unit prices).
 */
export function formatMoney(value: number, currency: string, options: MoneyFormatOptions = {}): string {
  const max = options.maxDecimals ?? 4;
  const key = `${currency}|${max}`;
  let f = formatters.get(key);
  if (!f) {
    const min = Math.min(currencyDigits(currency), max);
    f = new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      minimumFractionDigits: min,
      maximumFractionDigits: max,
    });
    formatters.set(key, f);
  }
  return f.format(value);
}
