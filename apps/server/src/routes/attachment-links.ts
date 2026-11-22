import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { redeemAttachmentLink } from "../services/attachment-links";
import { validate } from "../validate";
import { serveAttachment } from "./attachments";

/**
 * Redeems a signed attachment link (`GET …/attachments/:id/link`). Mounted at `/v1/public`: the
 * link itself is the credential, so there is no session, but the person it was made for must
 * still be a member who can read the file, and the file must still be live
 * (`redeemAttachmentLink`). Served like the content route, except it is never cached. Brake-limited
 * with the other public routes.
 */
export const attachmentLinkRoutes = new Hono<AppEnv>().get(
  "/attachment-links/:token",
  validate("param", z.object({ token: z.string().min(20).max(1024) })),
  async (c) => {
    const row = await redeemAttachmentLink(
      c.var.db,
      c.var.attachmentLinkKey,
      c.var.activeModules,
      c.req.valid("param").token,
    );
    return serveAttachment(c, row, { download: false, revalidate: false });
  },
);
