/** How many weeks the plan-from-demand page shows at a time (as the demand plan grid). */
export const PLAN_RANGES = [4, 8, 12, 26] as const;
export type PlanRange = (typeof PLAN_RANGES)[number];
