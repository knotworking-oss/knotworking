import { formatMoney } from "@knotworking/core";

/** An opportunity's estimated value, or a dash when it has none. */
export const opportunityValue = (o: { value: number | null; currency: string }) =>
  o.value === null ? "No value" : formatMoney(o.value, o.currency);

export const leadLabel = (lead: { name: string; company: string }) =>
  lead.company ? `${lead.company} · ${lead.name}` : lead.name;
