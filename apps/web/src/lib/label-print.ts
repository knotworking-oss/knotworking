import type { ProductLabelStatus } from "@knotworking/core";

export interface LabelPrintState {
  /** Wording stamped across the label; null when it is approved and current, so it may go on pack. */
  banner: "DRAFT" | "NEEDS REVIEW" | "SUPERSEDED" | null;
  status: string;
  reason: string | null;
}

/**
 * Whether a label may be printed for pack. Only an approved label that is not stale is clean:
 * a draft is not signed off, an approved one that needs review no longer matches its recipe or
 * ingredients, and a superseded one has been replaced by a newer approved label.
 */
export function labelPrintState(label: { status: ProductLabelStatus; stale: boolean }): LabelPrintState {
  if (label.status === "draft") {
    return {
      banner: "DRAFT",
      status: "Draft, not approved",
      reason: "This label has not been approved. Do not use it on pack.",
    };
  }
  if (label.status === "superseded") {
    return {
      banner: "SUPERSEDED",
      status: "Superseded",
      reason: "A newer label has been approved for this recipe. Do not use this one on pack.",
    };
  }
  if (label.stale) {
    return {
      banner: "NEEDS REVIEW",
      status: "Approved, needs review",
      reason: "The recipe or an ingredient changed after approval. Check the text before it goes on pack.",
    };
  }
  return { banner: null, status: "Approved", reason: null };
}
