import { apiTokenCreateSchema, apiTokenUpdateSchema } from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireSessionCredential } from "../middleware/auth";
import { createApiToken, listApiTokens, revokeApiToken, updateApiToken } from "../services/api-tokens";
import { validate } from "../validate";

/**
 * The signed-in user's personal API tokens. Mounted at `/v1/me`. Per-user, so nothing here touches
 * the workspace sync log. Only a real session may manage tokens (never a token itself).
 */
export const apiTokenRoutes = new Hono<AppEnv>()
  .get("/api-tokens", requireSessionCredential, async (c) =>
    c.json({ apiTokens: await listApiTokens(c.var.db, c.var.user.id) }),
  )
  // The plaintext `token` is in this response only; it can't be retrieved later.
  .post("/api-tokens", requireSessionCredential, validate("json", apiTokenCreateSchema), async (c) =>
    c.json(await createApiToken(c.var.db, c.var.user.id, c.req.valid("json")), 201),
  )
  // What the token may do through person-only actions (its allowlist and order cap). Sessions only:
  // a token must never widen its own powers.
  .patch(
    "/api-tokens/:id",
    requireSessionCredential,
    validate("param", z.object({ id: z.uuid() })),
    validate("json", apiTokenUpdateSchema),
    async (c) =>
      c.json({
        apiToken: await updateApiToken(c.var.db, c.var.user.id, c.req.valid("param").id, c.req.valid("json")),
      }),
  )
  .delete(
    "/api-tokens/:id",
    requireSessionCredential,
    validate("param", z.object({ id: z.uuid() })),
    async (c) => {
      await revokeApiToken(c.var.db, c.var.user.id, c.req.valid("param").id);
      return c.body(null, 204);
    },
  );
