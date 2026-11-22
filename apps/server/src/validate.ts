import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodType } from "zod";
import { badRequest } from "./errors";

/**
 * Zod-backed request validation that keeps Hono's end-to-end RPC types
 * (client input = schema input, handler sees schema output).
 */
export const validate = <Target extends keyof ValidationTargets, Schema extends ZodType>(
  target: Target,
  schema: Schema,
) =>
  zValidator(target, schema, (result) => {
    if (!result.success) throw badRequest(`Invalid ${target}`, result.error.issues);
  });
