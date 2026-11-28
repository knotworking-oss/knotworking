import { z } from "zod";
import { docContentSchema, docToPlainText } from "./content";
import { projectHealths } from "./enums";

const updateBody = docContentSchema.refine(
  (body) => docToPlainText(body).trim().length > 0,
  "Write a message",
);
export const projectUpdateCreateSchema = z.strictObject({ health: z.enum(projectHealths), body: updateBody });
export type ProjectUpdateCreateInput = z.infer<typeof projectUpdateCreateSchema>;
export const projectUpdateCommentSchema = z.strictObject({ body: updateBody });
export const projectUpdatePageSchema = z.object({
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export const PROJECT_UPDATE_INTERVAL_DAYS = 7;
