import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ATTACHMENT_LINK_TTL_SECONDS,
  attachmentTargets,
  hasModuleLevel,
  isAttachmentTargetType,
  type AttachmentLink,
  type ModuleId,
} from "@knotworking/core";
import { users, workspaceMembers, workspaces, type Database } from "@knotworking/db";
import { and, eq, isNull } from "drizzle-orm";
import { notFound } from "../errors";
import { findAttachment } from "./attachments";
import { memberModuleLevels } from "./module-access";

/**
 * Signed, short-lived download links for attachments (`GET …/attachments/:id/link`, redeemed at
 * `GET /v1/public/attachment-links/:token`). They exist for clients that can't hold the bytes
 * themselves, chiefly the MCP server: an agent hands the person a URL and the person's browser
 * fetches the file, so nothing but a link passes through the agent.
 *
 * The link is a bearer credential, so it is deliberately weak in every other way:
 *  - it names one attachment, one workspace and the person it was made for, signed with an HMAC
 *    key derived from the server secret (`deriveAttachmentLinkKey`), and expires after
 *    `ATTACHMENT_LINK_TTL_SECONDS`;
 *  - the access rules are checked twice: when it is made (the usual module `read` check, with the
 *    caller's token allowlist) and again when it is used, for the person it was made for, so a
 *    member removed or demoted in between, a deleted record or file, or a module switched off
 *    stops it working at once;
 *  - nothing is stored: there is no list of links to leak or revoke, and the short life is the
 *    revocation.
 */

export const deriveAttachmentLinkKey = (secret: string) =>
  createHmac("sha256", secret).update("knotworking:attachment-link:v1").digest();

interface LinkPayload {
  /** Attachment id. */
  a: string;
  /** Workspace id. */
  w: string;
  /** The person it was made for. */
  u: string;
  /** Expiry, seconds since the epoch. */
  e: number;
}

const sign = (key: Buffer, body: string) => createHmac("sha256", key).update(body).digest("base64url");

/** `<base64url payload>.<base64url signature>`. */
export function signAttachmentLink(key: Buffer, payload: LinkPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(key, body)}`;
}

/** The payload of a genuine, unexpired link, else null. */
export function verifyAttachmentLink(key: Buffer, token: string, now = Date.now()): LinkPayload | null {
  const [body, signature, ...rest] = token.split(".");
  if (!body || !signature || rest.length) return null;
  const expected = Buffer.from(sign(key, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<LinkPayload>;
    if (
      typeof payload.a !== "string" ||
      typeof payload.w !== "string" ||
      typeof payload.u !== "string" ||
      typeof payload.e !== "number" ||
      payload.e * 1000 <= now
    ) {
      return null;
    }
    return payload as LinkPayload;
  } catch {
    return null;
  }
}

/**
 * The module whose `read` access a file needs: a task's files the tasks module, a document's the
 * docs module, a module record's that record's module.
 */
export function attachmentModules(row: {
  taskId?: string | null;
  documentId?: string | null;
  entityType?: string | null;
}): ModuleId[] {
  const modules: ModuleId[] = [];
  if (row.taskId) modules.push("tasks");
  if (row.documentId) modules.push("docs");
  if (row.entityType && isAttachmentTargetType(row.entityType)) {
    modules.push(attachmentTargets[row.entityType].module);
  }
  return modules;
}

/** Makes a link for an attachment the caller has already been checked to read. */
export function makeAttachmentLink(
  key: Buffer,
  apiPublicUrl: string,
  file: { id: string; filename: string; contentType: string; size: number },
  workspaceId: string,
  userId: string,
  now = Date.now(),
): AttachmentLink {
  const exp = Math.floor(now / 1000) + ATTACHMENT_LINK_TTL_SECONDS;
  const token = signAttachmentLink(key, { a: file.id, w: workspaceId, u: userId, e: exp });
  return {
    url: `${apiPublicUrl}/v1/public/attachment-links/${token}`,
    expiresAt: new Date(exp * 1000).toISOString(),
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
  };
}

/**
 * Resolves a link to its attachment, re-checking everything a session would be: the signature and
 * expiry, that the person is still an active member of the workspace and can still read the
 * file's module, and that the file and its record are still live. Any failure is the same 404, so
 * a link doesn't say which of these it failed.
 */
export async function redeemAttachmentLink(
  db: Database,
  key: Buffer,
  active: readonly ModuleId[],
  token: string,
  now = Date.now(),
) {
  const payload = verifyAttachmentLink(key, token, now);
  const gone = notFound("Download link");
  if (!payload) throw gone;
  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, payload.w),
        eq(workspaceMembers.userId, payload.u),
        isNull(workspaceMembers.deletedAt),
        isNull(users.deletedAt),
        isNull(workspaces.deletedAt),
      ),
    );
  if (!member) throw gone;
  const row = await findAttachment(db, payload.w, payload.a);
  if (!row) throw gone;
  const levels = await memberModuleLevels(db, payload.w, { userId: payload.u, role: member.role }, active);
  const needed = attachmentModules(row);
  if (needed.length === 0 || !needed.every((m) => hasModuleLevel(levels[m], "read"))) throw gone;
  return row;
}
