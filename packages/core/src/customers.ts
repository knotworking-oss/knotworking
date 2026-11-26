import { z } from "zod";

export const customerStatuses = ["active", "archived"] as const;
const text = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();

export const customerCreateSchema = z.object({
  code: text(40),
  name: text(200),
  address: text(2000),
  contactName: nullableText(200).optional(),
  email: z
    .union([z.email().max(254), z.literal("")])
    .transform((v) => v || null)
    .nullable()
    .optional(),
  phone: nullableText(80).optional(),
  taxNumber: nullableText(40).optional(),
  status: z.enum(customerStatuses).default("active"),
});
export const customerUpdateSchema = customerCreateSchema
  .omit({ status: true })
  .partial()
  .extend({ status: z.enum(customerStatuses).optional() })
  .refine((v) => Object.keys(v).length > 0, "Pass at least one field to change");
export const customerListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum([...customerStatuses, "all"]).default("active"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;
export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;
