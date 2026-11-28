import { z } from "zod";
import { isValidSortKey } from "./ordering";

export const sectionCreateSchema = z.strictObject({ name: z.string().trim().min(1).max(120) });
export const sectionUpdateSchema = sectionCreateSchema
  .partial()
  .extend({ sortOrder: z.string().max(128).refine(isValidSortKey).optional() })
  .refine((patch) => Object.keys(patch).length > 0);
export type SectionCreateInput = z.infer<typeof sectionCreateSchema>;
export type SectionUpdateInput = z.infer<typeof sectionUpdateSchema>;
