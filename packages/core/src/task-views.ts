import { z } from "zod";
import { taskFilterSchema, taskOrderings } from "./task-filter";

export const taskViewScopes = ["personal", "team", "workspace"] as const;
export type TaskViewScope = (typeof taskViewScopes)[number];

export const taskViewSpecSchema = z.strictObject({
  filter: taskFilterSchema
    .nullable()
    .refine((filter) => JSON.stringify(filter).length <= 8192, "The filter is too long"),
  layout: z.enum(["list", "board", "calendar"]),
  sort: z.enum(taskOrderings),
});
export type TaskViewSpec = z.infer<typeof taskViewSpecSchema>;

const editableViewSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  icon: z.string().trim().min(1).max(16).nullable().optional(),
  spec: taskViewSpecSchema,
});

export const taskViewCreateSchema = editableViewSchema
  .extend({
    scope: z.enum(taskViewScopes),
    teamId: z.uuid().nullable().optional(),
  })
  .refine((view) => (view.scope === "team") === Boolean(view.teamId), {
    path: ["teamId"],
    message: "Only team views have a team",
  });

export const taskViewUpdateSchema = editableViewSchema
  .partial()
  .refine((view) => Object.keys(view).length > 0);
export type TaskViewCreateInput = z.infer<typeof taskViewCreateSchema>;
export type TaskViewUpdateInput = z.infer<typeof taskViewUpdateSchema>;
