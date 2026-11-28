import { z } from "zod";
import { isValidSortKey } from "./ordering";

export const milestoneCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  targetDate: z.iso.date().nullable().optional(),
});
export const milestoneUpdateSchema = milestoneCreateSchema
  .partial()
  .extend({
    completed: z.boolean().optional(),
    sortOrder: z.string().max(128).refine(isValidSortKey).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0);
export type MilestoneCreateInput = z.infer<typeof milestoneCreateSchema>;
export type MilestoneUpdateInput = z.infer<typeof milestoneUpdateSchema>;
