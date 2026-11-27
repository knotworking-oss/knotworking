import { z } from "zod";

export const DEFAULT_CLOSED_TASK_WINDOW_DAYS = 30;
export const MAX_CLOSED_TASK_WINDOW_DAYS = 3650;
export const closedTaskWindowDaysSchema = z.number().int().min(1).max(MAX_CLOSED_TASK_WINDOW_DAYS);
export const bootstrapQuerySchema = z.object({ taskWindow: z.literal("recent").optional() }).optional();

export const teamFeatures = ["cycles", "triage", "estimates"] as const;
export type TeamFeature = (typeof teamFeatures)[number];
export const teamFeaturesSchema = z
  .array(z.enum(teamFeatures))
  .max(teamFeatures.length)
  .refine((features) => new Set(features).size === features.length, "Duplicate team feature");

export function hasTeamFeature(team: { features?: readonly TeamFeature[] }, feature: TeamFeature) {
  return team.features?.includes(feature) ?? false;
}
