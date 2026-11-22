import {
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  hkdfSync,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import {
  formatBadgeCode,
  hasModuleLevel,
  KIOSK_BADGE_LENGTH,
  KIOSK_MAX_CLOCK_CORRECTION_MINUTES,
  KIOSK_PAIRING_ALPHABET,
  KIOSK_SEAL_HKDF_SALT,
  KIOSK_SEAL_VERSION,
  kioskRejectionLabels,
  kioskSealAad,
  kioskSealedClockSchema,
  kioskSealedVisitorInSchema,
  kioskSealedVisitorOutSchema,
  type AttendanceSettings,
  type KioskCredential,
  type KioskOfflineEvent,
  type KioskReplayStatus,
  type ModuleId,
  type WorkspaceRole,
  addDaysIso,
} from "@knotworking/core";
import {
  attendanceBadges,
  attendanceEvents,
  attendanceKioskRejections,
  attendanceVisits,
  sopAcknowledgements,
  sops,
  sopVersions,
  staff,
  users,
  workspaceMembers,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, desc, eq, ilike, inArray, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ApiError, notFound } from "../errors";
import {
  addOfflineClockEvent,
  getAttendanceSettings,
  signInVisitor,
  signOutVisitorByName,
  type KioskDevice,
} from "./attendance";
import { memberModuleLevels } from "./module-access";
import { verifyStaffPin } from "./people";
import { acknowledgeSop } from "./sops";
import { trainingDue } from "./ports/training";

/**
 * Attendance kiosk extras: badges, the offline queue, prompts at clock-in and visitor hosts.
 * See docs/modules.md (The kiosk).
 *
 * Every secret here is derived from the PIN key (`c.var.staffPinKey`, itself derived from
 * `BETTER_AUTH_SECRET`): the key offline events are sealed to, and the key prompt tokens are
 * signed with. Changing the secret invalidates them along with every PIN.
 */

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
type StaffRow = typeof staff.$inferSelect;

// ─── Who is at the kiosk ─────────────────────────────────────────────────────

export type CredentialCheck =
  | { ok: true; staff: StaffRow; pinVerified: boolean }
  | {
      ok: false;
      code: "pin_invalid" | "pin_locked" | "badge_invalid" | "staff_inactive" | "pin_required";
      lockedUntil?: Date;
      /** Counts towards the kiosk's wrong-PIN throttle. */
      counts: boolean;
    };

/** A badge is "last used" only when it let someone in, not on a refused or abandoned scan. */
const touchBadge = (db: Executor, id: string) =>
  db.update(attendanceBadges).set({ lastUsedAt: new Date() }).where(eq(attendanceBadges.id, id));

async function liveBadge(db: Executor, workspaceId: string, code: string) {
  const [row] = await db
    .select({ badge: attendanceBadges, staff })
    .from(attendanceBadges)
    .innerJoin(staff, and(eq(staff.id, attendanceBadges.staffId), isNull(staff.deletedAt)))
    .where(
      and(
        eq(attendanceBadges.workspaceId, workspaceId),
        eq(attendanceBadges.codeHash, sha256(code)),
        isNull(attendanceBadges.revokedAt),
      ),
    );
  return row ?? null;
}

/**
 * Checks who is at the kiosk: a staff number and PIN, or a badge. A badge needs the PIN as well
 * unless the workspace turned `badgeRequiresPin` off; a revoked or unknown badge is refused. Wrong
 * PINs count towards the lock-out exactly as at the keypad (`verifyStaffPin`).
 */
export async function checkKioskCredential(
  db: Executor,
  key: Buffer,
  workspaceId: string,
  settings: Pick<AttendanceSettings, "badgeRequiresPin">,
  credential: KioskCredential,
): Promise<CredentialCheck> {
  let staffNumber = credential.staffNumber;
  let badgeId: string | undefined;
  if (credential.badge !== undefined) {
    const found = await liveBadge(db, workspaceId, credential.badge);
    if (!found) return { ok: false, code: "badge_invalid", counts: true };
    badgeId = found.badge.id;
    if (credential.pin === undefined) {
      if (settings.badgeRequiresPin) return { ok: false, code: "pin_required", counts: false };
      if (found.staff.status !== "active") return { ok: false, code: "staff_inactive", counts: false };
      await touchBadge(db, badgeId);
      return { ok: true, staff: found.staff, pinVerified: false };
    }
    staffNumber = found.staff.staffNumber;
  }
  if (staffNumber === undefined || credential.pin === undefined) {
    return { ok: false, code: "pin_invalid", counts: true };
  }
  const check = await verifyStaffPin(db, key, workspaceId, staffNumber, credential.pin);
  if (check.ok) {
    if (badgeId) await touchBadge(db, badgeId);
    return { ok: true, staff: check.staff, pinVerified: true };
  }
  if (check.reason === "inactive") return { ok: false, code: "staff_inactive", counts: false };
  if (check.reason === "locked") {
    return { ok: false, code: "pin_locked", lockedUntil: check.lockedUntil, counts: true };
  }
  return { ok: false, code: "pin_invalid", counts: true };
}

// ─── Badges ──────────────────────────────────────────────────────────────────

const newBadgeCode = () =>
  Array.from(
    { length: KIOSK_BADGE_LENGTH },
    () => KIOSK_PAIRING_ALPHABET[randomInt(KIOSK_PAIRING_ALPHABET.length)],
  ).join("");

const issuer = alias(users, "issuer");

/** Active staff with their live badge, if any (managers print and revoke badges from this list). */
export async function listBadges(db: Database, workspaceId: string) {
  const rows = await db
    .select({
      staffId: staff.id,
      staffNumber: staff.staffNumber,
      firstName: staff.firstName,
      lastName: staff.lastName,
      department: staff.department,
      badgeId: attendanceBadges.id,
      hint: attendanceBadges.hint,
      issuedAt: attendanceBadges.createdAt,
      issuedByName: issuer.name,
      lastUsedAt: attendanceBadges.lastUsedAt,
    })
    .from(staff)
    .leftJoin(
      attendanceBadges,
      and(eq(attendanceBadges.staffId, staff.id), isNull(attendanceBadges.revokedAt)),
    )
    .leftJoin(issuer, eq(issuer.id, attendanceBadges.issuedBy))
    .where(and(eq(staff.workspaceId, workspaceId), eq(staff.status, "active"), isNull(staff.deletedAt)))
    .orderBy(asc(staff.lastName), asc(staff.firstName));
  return rows.map(({ staffId, badgeId, hint, issuedAt, issuedByName, lastUsedAt, ...person }) => ({
    staff: { id: staffId, ...person },
    badge: badgeId ? { id: badgeId, hint, issuedAt, issuedByName, lastUsedAt } : null,
  }));
}

/**
 * Issues a badge for an active person (`manage`, in person). Their previous badge stops working.
 * The code is returned once, here, for printing; only its hash is kept, so a lost or reprinted
 * badge is a new badge.
 */
export async function issueBadge(db: Database, workspaceId: string, actorId: string, staffId: string) {
  return db.transaction(async (tx) => {
    const [person] = await tx
      .select()
      .from(staff)
      .where(and(eq(staff.id, staffId), eq(staff.workspaceId, workspaceId), isNull(staff.deletedAt)))
      .for("update");
    if (!person) throw notFound("Staff member");
    if (person.status !== "active") {
      throw new ApiError(409, "staff_inactive", "Leavers can't be given a kiosk badge");
    }
    const now = new Date();
    await tx
      .update(attendanceBadges)
      .set({ revokedAt: now, revokedBy: actorId })
      .where(and(eq(attendanceBadges.staffId, staffId), isNull(attendanceBadges.revokedAt)));
    const code = newBadgeCode();
    const [row] = await tx
      .insert(attendanceBadges)
      .values({ workspaceId, staffId, codeHash: sha256(code), hint: code.slice(-4), issuedBy: actorId })
      .returning();
    return {
      code,
      printed: formatBadgeCode(code),
      badge: { id: row!.id, hint: row!.hint, issuedAt: row!.createdAt },
      staff: { id: person.id, firstName: person.firstName, lastName: person.lastName },
    };
  });
}

export async function revokeBadge(db: Database, workspaceId: string, actorId: string, id: string) {
  const [row] = await db
    .update(attendanceBadges)
    .set({ revokedAt: new Date(), revokedBy: actorId })
    .where(
      and(
        eq(attendanceBadges.id, id),
        eq(attendanceBadges.workspaceId, workspaceId),
        isNull(attendanceBadges.revokedAt),
      ),
    )
    .returning();
  if (!row) throw notFound("Badge");
  return { id: row.id, revokedAt: row.revokedAt };
}

// ─── Sealing (the offline queue) ─────────────────────────────────────────────

/** NIST P-256 group order: a private scalar must be below it. */
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const sealKeys = new Map<string, { ecdh: ReturnType<typeof createECDH>; publicKey: string; kid: string }>();

/**
 * The server's sealing key pair, derived from the PIN key so every API instance has the same one
 * and nothing is stored. The tablet gets the public key and seals each queued event to it with a
 * fresh ephemeral key (ECDH → HKDF-SHA-256 → AES-256-GCM); only the server can open it.
 */
export function kioskSealKey(key: Buffer) {
  const cacheKey = key.toString("hex");
  const cached = sealKeys.get(cacheKey);
  if (cached) return cached;
  let d = createHmac("sha256", key).update("knotworking:kiosk-seal:v1").digest();
  for (
    let i = 1;
    BigInt(`0x${d.toString("hex")}`) === 0n || BigInt(`0x${d.toString("hex")}`) >= P256_ORDER;
    i++
  ) {
    d = createHmac("sha256", key).update(`knotworking:kiosk-seal:v1:${i}`).digest();
  }
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  const entry = {
    ecdh,
    publicKey: pub.toString("base64url"),
    kid: createHash("sha256").update(pub).digest("hex").slice(0, 12),
  };
  sealKeys.set(cacheKey, entry);
  return entry;
}

/** Opens a sealed payload (`s1.<kid>.<ephemeral key>.<iv>.<ciphertext+tag>`), or null if it can't be. */
export function openSeal(key: Buffer, event: Pick<KioskOfflineEvent, "clientId" | "type" | "at" | "sealed">) {
  try {
    const [version, kid, epk, iv, data] = event.sealed.split(".");
    const keys = kioskSealKey(key);
    if (version !== KIOSK_SEAL_VERSION || kid !== keys.kid || !epk || !iv || !data) return null;
    const shared = keys.ecdh.computeSecret(Buffer.from(epk, "base64url"));
    const aesKey = Buffer.from(hkdfSync("sha256", shared, KIOSK_SEAL_HKDF_SALT, "aes-256-gcm", 32));
    const bytes = Buffer.from(data, "base64url");
    if (bytes.length < 17) return null;
    const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(kioskSealAad(event)));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const plain = Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

// ─── Prompt tokens ───────────────────────────────────────────────────────────

/**
 * How long a prompt token lasts: two minutes from clocking in, renewed by every SOP read or
 * acknowledged with it (each answer carries a fresh token). Short, so the next person at the kiosk
 * can't pick up where the last one walked off; the kiosk goes back to the start after the same
 * two minutes without a tap.
 */
export const PROMPT_TOKEN_MINUTES = 2;
const promptExpiry = () => Date.now() + PROMPT_TOKEN_MINUTES * 60_000;

interface PromptClaims {
  /** Staff id. */
  s: string;
  /** The linked member the acknowledgements are recorded for. */
  u: string;
  /** Device id: the token works on the kiosk that issued it only. */
  d: string;
  /** Expiry (ms since epoch). */
  e: number;
}

const promptKey = (key: Buffer) => createHmac("sha256", key).update("knotworking:kiosk-prompt:v1").digest();

function signPromptToken(key: Buffer, claims: PromptClaims) {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", promptKey(key)).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readPromptToken(key: Buffer, token: string, deviceId: string): PromptClaims {
  const [body, sig] = token.split(".");
  const refuse = () =>
    new ApiError(401, "prompt_expired", "That has timed out. Clock in again to see what's due.");
  if (!body || !sig) throw refuse();
  const expected = createHmac("sha256", promptKey(key)).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw refuse();
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PromptClaims;
  if (claims.d !== deviceId || claims.e < Date.now()) throw refuse();
  return claims;
}

// ─── Prompts at clock-in ─────────────────────────────────────────────────────

/** Training gaps shown at the kiosk: lapsed, outdated or overdue, and expiring or due within this many days. */
const PROMPT_TRAINING_DAYS = 30;
const PROMPT_SOP_LIMIT = 10;

/** The linked member's role and SOP level, or null when they can't read SOPs (or left the workspace). */
async function linkedSopReader(
  db: Executor,
  workspaceId: string,
  userId: string,
  active: readonly ModuleId[],
) {
  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  if (!member) return false;
  const levels = await memberModuleLevels(
    db,
    workspaceId,
    { userId, role: member.role as WorkspaceRole },
    active,
  );
  return hasModuleLevel(levels.sops, "read");
}

/** Current approved SOP versions `userId` hasn't acknowledged (the SOP module's own "pending"). */
async function unacknowledgedSops(db: Executor, workspaceId: string, userId: string) {
  const where = and(
    eq(sops.workspaceId, workspaceId),
    eq(sops.status, "active"),
    isNull(sops.deletedAt),
    notExists(
      db
        .select({ one: sql`1` })
        .from(sopAcknowledgements)
        .where(
          and(eq(sopAcknowledgements.versionId, sopVersions.id), eq(sopAcknowledgements.userId, userId)),
        ),
    ),
  );
  const join = and(
    eq(sopVersions.sopId, sops.id),
    eq(sopVersions.status, "approved"),
    isNull(sopVersions.deletedAt),
  );
  const [rows, [total]] = await Promise.all([
    db
      .select({
        sopId: sops.id,
        code: sops.code,
        title: sopVersions.title,
        versionId: sopVersions.id,
        versionNumber: sopVersions.versionNumber,
        effectiveOn: sopVersions.effectiveOn,
      })
      .from(sops)
      .innerJoin(sopVersions, join)
      .where(where)
      .orderBy(desc(sopVersions.decidedAt), asc(sops.code))
      .limit(PROMPT_SOP_LIMIT),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(sops)
      .innerJoin(sopVersions, join)
      .where(where),
  ]);
  return { items: rows, total: total?.n ?? 0 };
}

export interface KioskContext {
  db: Database;
  key: Buffer;
  device: KioskDevice;
  activeModules: readonly ModuleId[];
}

/**
 * What a person should see after clocking in: SOPs to read and acknowledge, and training that has
 * lapsed or is falling due. Each part only when its module is on.
 *
 * - **SOPs** use the SOP module's own model: acknowledgements belong to members, so they are shown
 *   to staff linked to a member who can read SOPs, and are the current versions that member hasn't
 *   acknowledged. Acknowledging at the kiosk needs the PIN to have been checked (not a badge alone)
 *   and is allowed for `PROMPT_TOKEN_MINUTES` with the token returned here.
 * - **Training** is for everyone on the staff list. Sign-off stays a manager's act: the kiosk informs.
 */
export async function kioskPrompts(ctx: KioskContext, person: StaffRow, pinVerified: boolean) {
  const { db, device, activeModules } = ctx;
  const workspaceId = device.workspaceId;
  const due = activeModules.includes("training")
    ? await trainingDue(db, workspaceId, { withinDays: PROMPT_TRAINING_DAYS, staffIds: [person.id] })
    : null;
  // `due.today` is today in the workspace's time zone.
  const horizon = due ? addDaysIso(due.today, PROMPT_TRAINING_DAYS) : null;
  const training = due
    ? due.items
        .filter(
          (i) =>
            i.status === "expired" ||
            i.status === "outdated" ||
            i.status === "expiring" ||
            (i.status === "missing" && (i.overdue || (i.dueOn !== null && i.dueOn <= horizon!))),
        )
        .map((i) => ({
          courseId: i.course.id,
          code: i.course.code,
          title: i.course.title,
          status: i.status,
          dueOn: i.dueOn,
          overdue: i.overdue || i.status === "expired",
        }))
    : [];
  let sopPrompts: Awaited<ReturnType<typeof unacknowledgedSops>> = { items: [], total: 0 };
  let promptToken: string | null = null;
  if (
    activeModules.includes("sops") &&
    person.userId &&
    (await linkedSopReader(db, workspaceId, person.userId, activeModules))
  ) {
    sopPrompts = await unacknowledgedSops(db, workspaceId, person.userId);
    if (sopPrompts.total > 0 && pinVerified) {
      promptToken = signPromptToken(ctx.key, {
        s: person.id,
        u: person.userId,
        d: device.id,
        e: promptExpiry(),
      });
    }
  }
  return {
    training,
    sops: sopPrompts.items,
    sopsTotal: sopPrompts.total,
    /** Present when the person may acknowledge here (PIN checked, linked member who can read SOPs). */
    promptToken,
  };
}

/** Checks a prompt token and that its member may still read SOPs. */
async function promptReader(ctx: KioskContext, token: string) {
  if (!ctx.activeModules.includes("sops")) {
    throw new ApiError(404, "module_inactive", "The SOPs module is not enabled on this server");
  }
  const claims = readPromptToken(ctx.key, token, ctx.device.id);
  const [person] = await ctx.db
    .select({ userId: staff.userId, status: staff.status })
    .from(staff)
    .where(and(eq(staff.id, claims.s), isNull(staff.deletedAt)));
  if (
    !person ||
    person.status !== "active" ||
    person.userId !== claims.u ||
    !(await linkedSopReader(ctx.db, ctx.device.workspaceId, claims.u, ctx.activeModules))
  ) {
    throw new ApiError(403, "sop_access_required", "You can't read SOPs here. Please ask a manager.");
  }
  return claims;
}

/** A renewed token for the same person and kiosk, valid for another `PROMPT_TOKEN_MINUTES`. */
const renewPromptToken = (ctx: KioskContext, claims: PromptClaims) =>
  signPromptToken(ctx.key, { ...claims, e: promptExpiry() });

/** The current version of an SOP, to read at the kiosk before acknowledging it. */
export async function kioskReadSop(ctx: KioskContext, sopId: string, token: string) {
  const claims = await promptReader(ctx, token);
  const [row] = await ctx.db
    .select({
      sopId: sops.id,
      code: sops.code,
      title: sopVersions.title,
      versionId: sopVersions.id,
      versionNumber: sopVersions.versionNumber,
      content: sopVersions.content,
    })
    .from(sops)
    .innerJoin(
      sopVersions,
      and(eq(sopVersions.sopId, sops.id), eq(sopVersions.status, "approved"), isNull(sopVersions.deletedAt)),
    )
    .where(
      and(
        eq(sops.id, sopId),
        eq(sops.workspaceId, ctx.device.workspaceId),
        eq(sops.status, "active"),
        isNull(sops.deletedAt),
      ),
    );
  if (!row) throw notFound("SOP");
  return { ...row, promptToken: renewPromptToken(ctx, claims) };
}

/** "Read and understood" at the kiosk, recorded for the linked member (`source: kiosk`). */
export async function kioskAcknowledgeSop(
  ctx: KioskContext,
  sopId: string,
  token: string,
  versionId: string,
) {
  const claims = await promptReader(ctx, token);
  const ack = await acknowledgeSop(
    ctx.db,
    ctx.device.workspaceId,
    claims.u,
    sopId,
    versionId,
    "kiosk",
    ctx.activeModules,
  );
  return {
    sopId,
    versionId: ack.versionId,
    acknowledgedAt: ack.acknowledgedAt,
    promptToken: renewPromptToken(ctx, claims),
  };
}

// ─── Visitor hosts ───────────────────────────────────────────────────────────

/** Escapes `%` and `_` so a search box matches them literally. */
const escapeLike = (q: string) => q.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * Who a visitor can say they are visiting: active staff and workspace members whose first or last
 * name starts with what was typed (at least three characters; at most eight answers). Names only,
 * no department: the kiosk is a shared screen in reception, and any paired tablet may ask, so it
 * mustn't be a way to list the directory. Guests and deleted accounts are never hosts. Members
 * linked to an active member of staff appear once, as that person of staff; a member linked to a
 * leaver is still found as a member. Rate-limited per kiosk (`routes/kiosk.ts`).
 */
export async function searchVisitorHosts(db: Database, workspaceId: string, q: string) {
  const prefix = `${escapeLike(q)}%`;
  const wordPrefix = `% ${escapeLike(q)}%`;
  const people = await db
    .select({
      id: staff.id,
      firstName: staff.firstName,
      lastName: staff.lastName,
      userId: staff.userId,
    })
    .from(staff)
    .where(
      and(
        eq(staff.workspaceId, workspaceId),
        eq(staff.status, "active"),
        isNull(staff.deletedAt),
        or(
          ilike(staff.firstName, prefix),
          ilike(staff.lastName, prefix),
          ilike(sql`${staff.firstName} || ' ' || ${staff.lastName}`, prefix),
        ),
      ),
    )
    .orderBy(asc(staff.lastName), asc(staff.firstName))
    .limit(8);
  const members = await db
    .select({ id: users.id, name: users.name })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        isNull(workspaceMembers.deletedAt),
        ne(workspaceMembers.role, "guest"),
        isNull(users.deletedAt),
        or(ilike(users.name, prefix), ilike(users.name, wordPrefix)),
      ),
    )
    .orderBy(asc(users.name))
    .limit(8);
  const linked = new Set(people.flatMap((p) => (p.userId ? [p.userId] : [])));
  // A member linked to an active member of staff (who may not have matched by name) is that person.
  const memberIds = members.map((m) => m.id);
  if (memberIds.length) {
    const rows = await db
      .select({ userId: staff.userId })
      .from(staff)
      .where(
        and(
          eq(staff.workspaceId, workspaceId),
          inArray(staff.userId, memberIds),
          eq(staff.status, "active"),
          isNull(staff.deletedAt),
        ),
      );
    for (const r of rows) if (r.userId) linked.add(r.userId);
  }
  return [
    ...people.map((p) => ({ kind: "staff" as const, id: p.id, name: `${p.firstName} ${p.lastName}` })),
    ...members
      .filter((m) => !linked.has(m.id))
      .map((m) => ({ kind: "member" as const, id: m.id, name: m.name })),
  ].slice(0, 8);
}

// ─── Offline replay ──────────────────────────────────────────────────────────

/** A tablet clock this far ahead of the server is still accepted (small drift between corrections). */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const MAX_CLOCK_CORRECTION_MS = KIOSK_MAX_CLOCK_CORRECTION_MINUTES * 60_000;

/**
 * How far to move a queued entry's tablet time to get the server's time. The kiosk learns the
 * difference between its clock and the server's at its last `GET /v1/kiosk/session` (which returns
 * the server's `now`) and seals it into each entry (`clockOffsetMs`), so the correction is as
 * authenticated as the entry itself: nobody holding the queue can re-time an entry. Entries sealed
 * before the kiosk did this have no offset; for them the batch's unauthenticated `sentAt` is used,
 * and the same cap (`KIOSK_MAX_CLOCK_CORRECTION_MINUTES`) bounds how far it can move them. Beyond
 * the cap the entry is refused (`clock_skew`) for a manager to add by hand, not moved.
 */
function clockCorrection(payload: unknown, legacySkew: number): number {
  const offset =
    payload !== null && typeof payload === "object" && "clockOffsetMs" in payload
      ? (payload as { clockOffsetMs: unknown }).clockOffsetMs
      : undefined;
  if (typeof offset === "number" && Number.isFinite(offset)) return offset;
  return Number.isFinite(legacySkew) ? legacySkew : Number.POSITIVE_INFINITY;
}

export interface ReplayResult {
  clientId: string;
  status: KioskReplayStatus | "deferred";
  code?: string;
  message?: string;
}

/** The kiosk's wrong-PIN throttle, shared with the live routes. */
export interface ReplayGuard {
  throttled(): boolean;
  countFailure(): void;
}

/** What is already known about a client id: a recorded event or visit, or an earlier refusal. */
async function priorOutcome(
  db: Executor,
  workspaceId: string,
  clientId: string,
): Promise<ReplayResult | null> {
  const [event] = await db
    .select({ id: attendanceEvents.id })
    .from(attendanceEvents)
    .where(and(eq(attendanceEvents.workspaceId, workspaceId), eq(attendanceEvents.clientId, clientId)));
  if (event) return { clientId, status: "duplicate" };
  const [visit] = await db
    .select({ id: attendanceVisits.id })
    .from(attendanceVisits)
    .where(
      and(
        eq(attendanceVisits.workspaceId, workspaceId),
        or(eq(attendanceVisits.clientId, clientId), eq(attendanceVisits.signOutClientId, clientId)),
      ),
    );
  if (visit) return { clientId, status: "duplicate" };
  const [rejection] = await db
    .select({ code: attendanceKioskRejections.code, message: attendanceKioskRejections.message })
    .from(attendanceKioskRejections)
    .where(
      and(
        eq(attendanceKioskRejections.workspaceId, workspaceId),
        eq(attendanceKioskRejections.clientId, clientId),
      ),
    );
  if (rejection) return { clientId, status: "rejected", ...rejection };
  return null;
}

/**
 * Replays events a kiosk queued while offline. Idempotent: each is keyed on its client id, so a
 * retry (a lost response, a second tab) returns the same answer and never clocks twice or counts
 * a wrong PIN twice. Each event is replayed in its own transaction holding an advisory lock on the
 * workspace and client id, taken before the PIN is checked, so concurrent replays of one event
 * are serialised. Events are applied in time order. Each one is:
 *
 * - **duplicate**: already recorded (this client id, or the same clock within two minutes);
 * - **accepted**: recorded at the time it happened, marked `offline`;
 * - **rejected**: refused for good, with a code, and kept for managers (Settings & kiosks) so
 *   they can add it by hand: outside the replay window, in the future, a wrong PIN or revoked
 *   badge, a leaver, or contradicting the recorded clock events;
 * - **deferred**: not stored; send it again later. `kiosk_throttled`: not tried because the kiosk
 *   hit its wrong-PIN throttle. `awaiting_clock_in`: a clock-out with no clock-in before it yet
 *   (another offline kiosk may still be holding it), retried until the replay window has passed.
 *
 * The tablet's clock may be wrong: every time is corrected by the offset sealed in the entry
 * (`clockCorrection`), at most `KIOSK_MAX_CLOCK_CORRECTION_MINUTES`; beyond that it is refused.
 */
export async function replayOfflineEvents(
  ctx: KioskContext,
  guard: ReplayGuard,
  input: { sentAt: string; events: KioskOfflineEvent[] },
): Promise<ReplayResult[]> {
  const { db, key, device } = ctx;
  const workspaceId = device.workspaceId;
  const settings = await getAttendanceSettings(db, workspaceId);
  const now = Date.now();
  // Only for entries queued before the kiosk sealed its offset (see `clockCorrection`).
  const legacySkew = now - Date.parse(input.sentAt);
  const ordered = input.events
    .map((e, i) => {
      const payload = openSeal(key, e);
      const correction = clockCorrection(payload, legacySkew);
      const raw = Date.parse(e.at);
      const at = new Date(Math.abs(correction) <= MAX_CLOCK_CORRECTION_MS ? raw + correction : raw);
      return { e, i, at, opened: { payload, correction } };
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.i - b.i);
  const results = new Map<string, ReplayResult>();
  for (const { e, at, opened } of ordered) {
    if (results.has(e.clientId)) continue; // The same id twice in one batch.
    results.set(
      e.clientId,
      // One replay of a client id at a time (two tabs, or a retry racing a slow first attempt):
      // the second waits, then finds the first one's outcome, so a wrong PIN counts once.
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${e.clientId}`}, 3))`,
        );
        return replayOne({ ...ctx, db: tx as unknown as Database }, guard, settings, e, at, now, opened);
      }),
    );
  }
  return input.events.map((e) => results.get(e.clientId)!);
}

async function replayOne(
  ctx: KioskContext,
  guard: ReplayGuard,
  settings: AttendanceSettings,
  e: KioskOfflineEvent,
  at: Date,
  now: number,
  { payload, correction }: { payload: unknown; correction: number },
): Promise<ReplayResult> {
  const { db, key, device } = ctx;
  const workspaceId = device.workspaceId;
  const prior = await priorOutcome(db, workspaceId, e.clientId);
  if (prior) return prior;
  const reject = (
    code: string,
    extra: { message?: string; staffId?: string | null; detail?: string | null } = {},
  ) => recordRejection(db, device, e, at, code, extra);

  if (payload === null) return reject("seal_invalid");
  if (Math.abs(correction) > MAX_CLOCK_CORRECTION_MS) {
    const minutes = Math.round(Math.abs(correction) / 60_000);
    return reject("clock_skew", {
      message: `The tablet's clock was ${minutes} minutes ${correction < 0 ? "fast" : "slow"} (more than ${KIOSK_MAX_CLOCK_CORRECTION_MINUTES}): check its time, and add this by hand if it's right.`,
    });
  }
  if (at.getTime() < now - settings.offlineReplayHours * 3_600_000) {
    return reject("replay_too_old", {
      message: `Older than ${settings.offlineReplayHours} hours: add it by hand if it's right.`,
    });
  }
  if (at.getTime() > now + FUTURE_TOLERANCE_MS) return reject("replay_in_future");

  if (e.type === "clock_in" || e.type === "clock_out") {
    const parsed = kioskSealedClockSchema.safeParse(payload);
    if (!parsed.success) return reject("invalid");
    if (guard.throttled()) return { clientId: e.clientId, status: "deferred", code: "kiosk_throttled" };
    const check = await checkKioskCredential(db, key, workspaceId, settings, parsed.data);
    if (!check.ok) {
      if (check.counts) guard.countFailure();
      const who = await identifyForReport(db, workspaceId, parsed.data);
      return reject(check.code, who);
    }
    const outcome = await addOfflineClockEvent(
      db,
      device,
      check.staff.id,
      e.type === "clock_in" ? "in" : "out",
      at,
      e.clientId,
      settings.maxShiftHours,
      settings.timeZone,
    );
    if (outcome.status === "conflict") {
      return reject("replay_conflict", { message: outcome.message, staffId: check.staff.id });
    }
    if (outcome.status === "no_open_in") {
      // Two offline kiosks may replay out of order: the clock-in from the other kiosk may not have
      // arrived yet. Not stored: the kiosk keeps it and tries again until it fits, or until it is
      // older than the replay window (then it is refused as `replay_too_old` above).
      return {
        clientId: e.clientId,
        status: "deferred",
        code: "awaiting_clock_in",
        message: `${outcome.message} yet: kept on the kiosk and tried again`,
      };
    }
    return { clientId: e.clientId, status: outcome.status };
  }

  if (e.type === "visitor_in") {
    const parsed = kioskSealedVisitorInSchema.safeParse(payload);
    if (!parsed.success) return reject("invalid");
    const { clockOffsetMs: _offset, siteRules, hostName, ...visit } = parsed.data;
    const detail = `Visitor ${visit.firstName} ${visit.lastName}`;
    try {
      // Recorded against what the kiosk showed, whatever changed since (see `signInVisitor`).
      const done = await signInVisitor(
        db,
        workspaceId,
        { deviceId: device.id, at, offline: true },
        { ...visit, clientId: e.clientId },
        { siteRules, hostName },
      );
      return { clientId: e.clientId, status: done.repeated ? "duplicate" : "accepted" };
    } catch (err) {
      if (err instanceof ApiError && (err.code === "site_rules_required" || err.code === "host_not_found")) {
        return reject(err.code, { detail });
      }
      throw err;
    }
  }

  const parsed = kioskSealedVisitorOutSchema.safeParse(payload);
  if (!parsed.success) return reject("invalid");
  try {
    const done = await signOutVisitorByName(
      db,
      workspaceId,
      { deviceId: device.id, at, offline: true },
      { ...parsed.data, clientId: e.clientId },
    );
    return { clientId: e.clientId, status: done.repeated ? "duplicate" : "accepted" };
  } catch (err) {
    if (err instanceof ApiError && err.code === "visitor_not_found") {
      return reject(err.code, { detail: `Visitor ${parsed.data.firstName} ${parsed.data.lastName}` });
    }
    throw err;
  }
}

/** Who a refused clock event was for, as far as the server can tell (for the manager's list). */
async function identifyForReport(db: Executor, workspaceId: string, credential: KioskCredential) {
  if (credential.badge !== undefined) {
    const found = await liveBadge(db, workspaceId, credential.badge);
    return found ? { staffId: found.staff.id } : { detail: "Unknown or revoked badge" };
  }
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.workspaceId, workspaceId), eq(staff.staffNumber, credential.staffNumber ?? "")));
  return row ? { staffId: row.id } : { detail: `Staff number ${credential.staffNumber}` };
}

async function recordRejection(
  db: Executor,
  device: KioskDevice,
  e: KioskOfflineEvent,
  at: Date,
  code: string,
  extra: { message?: string; staffId?: string | null; detail?: string | null },
): Promise<ReplayResult> {
  const message = extra.message ?? kioskRejectionLabels[code] ?? code;
  const [row] = await db
    .insert(attendanceKioskRejections)
    .values({
      workspaceId: device.workspaceId,
      deviceId: device.id,
      clientId: e.clientId,
      type: e.type,
      at,
      code,
      message,
      staffId: extra.staffId ?? null,
      detail: extra.detail ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    // Another request refused the same event first: give its answer.
    return (
      (await priorOutcome(db, device.workspaceId, e.clientId)) ?? {
        clientId: e.clientId,
        status: "rejected",
        code,
        message,
      }
    );
  }
  return { clientId: e.clientId, status: "rejected", code, message };
}

// ─── Refused events, for managers ────────────────────────────────────────────

const dismisser = alias(users, "dismisser");

export async function listKioskRejections(db: Database, workspaceId: string, includeDismissed: boolean) {
  const rows = await db
    .select({
      rejection: attendanceKioskRejections,
      staffNumber: staff.staffNumber,
      firstName: staff.firstName,
      lastName: staff.lastName,
      dismissedByName: dismisser.name,
    })
    .from(attendanceKioskRejections)
    .leftJoin(staff, eq(staff.id, attendanceKioskRejections.staffId))
    .leftJoin(dismisser, eq(dismisser.id, attendanceKioskRejections.dismissedBy))
    .where(
      and(
        eq(attendanceKioskRejections.workspaceId, workspaceId),
        includeDismissed ? undefined : isNull(attendanceKioskRejections.dismissedAt),
      ),
    )
    .orderBy(desc(attendanceKioskRejections.at))
    .limit(200);
  return rows.map(({ rejection, staffNumber, firstName, lastName, dismissedByName }) => {
    const { workspaceId: _ws, deletedAt: _deleted, updatedAt: _updated, ...rest } = rejection;
    return {
      ...rest,
      staff: rest.staffId ? { id: rest.staffId, staffNumber, firstName, lastName } : null,
      dismissedByName,
    };
  });
}

/** A manager has dealt with a refused event (added it by hand, or it was wrong). */
export async function dismissKioskRejection(db: Database, workspaceId: string, actorId: string, id: string) {
  const [row] = await db
    .update(attendanceKioskRejections)
    .set({ dismissedAt: new Date(), dismissedBy: actorId })
    .where(
      and(
        eq(attendanceKioskRejections.id, id),
        eq(attendanceKioskRejections.workspaceId, workspaceId),
        isNull(attendanceKioskRejections.dismissedAt),
      ),
    )
    .returning();
  if (!row) throw notFound("Refused kiosk event");
  return { id: row.id, dismissedAt: row.dismissedAt };
}
