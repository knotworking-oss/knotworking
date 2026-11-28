import { z } from "zod";

export const customFieldTargets = ["task", "project"] as const;
export const customFieldTypes = [
  "text",
  "number",
  "date",
  "single_select",
  "multi_select",
  "person",
  "checkbox",
  "url",
] as const;
export type CustomFieldTarget = (typeof customFieldTargets)[number];
export type CustomFieldType = (typeof customFieldTypes)[number];

const id = z.uuid().toLowerCase();
const name = z.string().trim().min(1).max(100);
const optionSchema = z.strictObject({ id, label: name });
export type CustomFieldOption = z.infer<typeof optionSchema>;
const optionsSchema = z
  .array(optionSchema)
  .max(100)
  .refine(
    (options) => new Set(options.map((option) => option.id)).size === options.length,
    "Option IDs must be unique",
  );

export const customFieldDefinitionCreateSchema = z
  .strictObject({
    target: z.enum(customFieldTargets),
    type: z.enum(customFieldTypes),
    name,
    options: optionsSchema.optional(),
    teamId: id.nullable().optional(),
    projectId: id.nullable().optional(),
  })
  .refine((field) => !(field.teamId && field.projectId), "Choose either a team or a project");
export type CustomFieldDefinitionCreateInput = z.infer<typeof customFieldDefinitionCreateSchema>;

export const customFieldDefinitionUpdateSchema = z
  .strictObject({
    name: name.optional(),
    options: optionsSchema.optional(),
  })
  .refine((field) => Object.keys(field).length > 0, "Change at least one property");
export type CustomFieldDefinitionUpdateInput = z.infer<typeof customFieldDefinitionUpdateSchema>;

const numericValue = z.number().min(-1e12).max(1e12);
const urlValue = z.url({ protocol: /^https?$/ }).max(2048);
const dateValue = z.iso.date().refine((date) => !date.startsWith("0000"));
const optionIds = z
  .array(id)
  .max(100)
  .transform((values) => [...new Set(values)]);

export const customFieldValueSchemas = {
  text: z.string().trim().min(1).max(10_000),
  number: numericValue,
  date: dateValue,
  single_select: id,
  multi_select: optionIds,
  person: id,
  checkbox: z.boolean(),
  url: urlValue,
} satisfies Record<CustomFieldType, z.ZodType>;

export const customFieldValueSchema = z.strictObject({
  value: z.union([z.string().max(10_000), numericValue, z.boolean(), optionIds]).nullable(),
});
export type CustomFieldValue = z.infer<typeof customFieldValueSchema>["value"];
