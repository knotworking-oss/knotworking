import {
  kioskAcknowledgeSchema,
  kioskChangePinSchema,
  kioskClockSchema,
  kioskHostQuerySchema,
  kioskIdentifySchema,
  kioskPairSchema,
  kioskPromptReadSchema,
  kioskReplaySchema,
  kioskVisitorSchema,
  kioskVisitorSignInSchema,
  KIOSK_SEAL_VERSION,
  STAFF_PIN_LOCK_MINUTES,
  type KioskCredential,
} from "@knotworking/core";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError } from "../errors";
import { bearerValue } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import {
  authenticateDevice,
  getAttendanceSettings,
  kioskClock,
  kioskExpected,
  pairDevice,
  signInVisitor,
  signOutVisitorByName,
  type KioskDevice,
} from "../services/attendance";
import {
  checkKioskCredential,
  kioskAcknowledgeSop,
  kioskPrompts,
  kioskReadSop,
  kioskSealKey,
  replayOfflineEvents,
  searchVisitorHosts,
  type CredentialCheck,
  type KioskContext,
} from "../services/attendance-kiosk";
import { changeOwnStaffPin } from "../services/people";
import { getActiveWorkspaceModules } from "../services/workspace-modules";
import { validate } from "../validate";

/**
 * The attendance kiosk: a paired tablet, not a person. Its credential (`knk_…`, from pairing) is
 * accepted here and nowhere else, and sessions and personal API tokens are not accepted here. It
 * can only clock people in and out after checking their staff number and PIN (or badge), let them
 * change their PIN, sign visitors in and out, replay what it queued while offline, and show a
 * person who has just clocked in what is due for them. It can't read anyone's times or who is on
 * site.
 */

export interface KioskEnv {
  Variables: AppEnv["Variables"] & { device: KioskDevice };
}

export const requireDevice = createMiddleware<KioskEnv>(async (c, next) => {
  if (!c.var.activeModules.includes("attendance")) {
    throw new ApiError(404, "module_inactive", "The attendance module is not enabled on this server");
  }
  const token = bearerValue(c.req.raw.headers);
  const device = token ? await authenticateDevice(c.var.db, token) : null;
  if (!device)
    throw new ApiError(401, "device_required", "This kiosk isn't paired, or its pairing was removed");
  const active = await getActiveWorkspaceModules(c.var.db, device.workspaceId, c.var.activeModules);
  if (!active.includes("attendance")) {
    throw new ApiError(404, "module_inactive", "The attendance module is not enabled in this workspace");
  }
  c.set("activeModules", active);
  c.set("device", device);
  await next();
});

/** Wrong PINs per kiosk: on top of the lock per staff number, a kiosk being worked through numbers slows down. */
const DEVICE_FAILURES = 30;
const DEVICE_WINDOW_MS = 5 * 60_000;
const failures = new Map<string, { count: number; resetAt: number }>();

function isThrottled(deviceId: string) {
  const entry = failures.get(deviceId);
  return Boolean(entry && entry.resetAt > Date.now() && entry.count >= DEVICE_FAILURES);
}
function assertDeviceNotThrottled(deviceId: string) {
  if (isThrottled(deviceId)) {
    throw new ApiError(429, "kiosk_throttled", "Too many wrong PINs on this kiosk. Wait a few minutes.");
  }
}
function countFailure(deviceId: string) {
  const now = Date.now();
  const entry = failures.get(deviceId);
  if (!entry || entry.resetAt <= now) failures.set(deviceId, { count: 1, resetAt: now + DEVICE_WINDOW_MS });
  else entry.count++;
}

/**
 * Host searches per kiosk: enough for people typing names at reception (the page waits for a pause
 * in typing), not for walking the directory three letters at a time.
 */
export const HOST_SEARCHES_PER_MINUTE = 30;
const hostSearchLimit = rateLimit({
  max: HOST_SEARCHES_PER_MINUTE,
  windowMs: 60_000,
  key: (c) => `kiosk-hosts:${(c.var as KioskEnv["Variables"]).device.id}`,
});

/** Turns a failed check into one answer for unknown numbers, missing PINs and wrong PINs. */
function refuse(deviceId: string, check: Extract<CredentialCheck, { ok: false }>): never {
  if (check.counts) countFailure(deviceId);
  switch (check.code) {
    case "staff_inactive":
      throw new ApiError(
        403,
        "staff_inactive",
        "You're not set up as active staff here. Please see a manager.",
      );
    case "pin_required":
      throw new ApiError(401, "pin_required", "Enter your PIN as well as scanning your badge.");
    case "badge_invalid":
      throw new ApiError(
        401,
        "badge_invalid",
        "That badge isn't recognised. It may have been replaced: please see a manager.",
      );
    case "pin_locked": {
      const until = check.lockedUntil?.getTime() ?? Date.now();
      const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
      throw new ApiError(
        423,
        "pin_locked",
        `Too many wrong PINs for this staff number. Try again in ${Math.min(minutes, STAFF_PIN_LOCK_MINUTES)} minutes, or ask a manager to unlock it.`,
      );
    }
    default:
      throw new ApiError(401, "pin_invalid", "That staff number and PIN don't match.");
  }
}

async function identify(c: { var: KioskEnv["Variables"] }, credential: KioskCredential) {
  assertDeviceNotThrottled(c.var.device.id);
  const settings = await getAttendanceSettings(c.var.db, c.var.device.workspaceId);
  const check = await checkKioskCredential(
    c.var.db,
    c.var.staffPinKey,
    c.var.device.workspaceId,
    settings,
    credential,
  );
  if (!check.ok) refuse(c.var.device.id, check);
  return check;
}

const kioskContext = (c: { var: KioskEnv["Variables"] }): KioskContext => ({
  db: c.var.db,
  key: c.var.staffPinKey,
  device: c.var.device,
  activeModules: c.var.activeModules,
});

const credentialOf = (v: KioskCredential): KioskCredential => ({
  ...(v.staffNumber !== undefined ? { staffNumber: v.staffNumber } : {}),
  ...(v.badge !== undefined ? { badge: v.badge } : {}),
  ...(v.pin !== undefined ? { pin: v.pin } : {}),
});

const idParam = z.object({ id: z.uuid() });

/** `POST /v1/public/kiosk/pair`: no credential (the pairing code is it), rate-limited with the other public routes. */
export const kioskPairRoutes = new Hono<AppEnv>().post(
  "/kiosk/pair",
  validate("json", kioskPairSchema),
  async (c) => {
    if (!c.var.activeModules.includes("attendance")) {
      throw new ApiError(404, "module_inactive", "The attendance module is not enabled on this server");
    }
    return c.json(await pairDevice(c.var.db, c.req.valid("json").code, c.var.activeModules));
  },
);

/** Mounted at `/v1/kiosk`, behind `requireDevice`. */
export const kioskRoutes = new Hono<KioskEnv>()
  .get("/session", async (c) => {
    const settings = await getAttendanceSettings(c.var.db, c.var.device.workspaceId);
    const seal = kioskSealKey(c.var.staffPinKey);
    return c.json({
      device: { id: c.var.device.id, name: c.var.device.name },
      workspace: { name: c.var.device.workspaceName },
      settings: {
        badgeRequiresPin: settings.badgeRequiresPin,
        offlineReplayHours: settings.offlineReplayHours,
        visitorSiteRules: settings.visitorSiteRules,
      },
      /** The public key offline events are sealed to (P-256, uncompressed, base64url). */
      seal: { version: KIOSK_SEAL_VERSION, kid: seal.kid, publicKey: seal.publicKey },
      now: new Date(),
    });
  })
  .post("/identify", validate("json", kioskIdentifySchema), async (c) => {
    const check = await identify(c, credentialOf(c.req.valid("json")));
    const { expected, last } = await kioskExpected(c.var.db, c.var.device.workspaceId, check.staff.id);
    // First name only: the kiosk is a shared screen.
    return c.json({
      firstName: check.staff.firstName,
      expected,
      last: last ? { kind: last.kind, at: last.at } : null,
    });
  })
  .post("/clock", validate("json", kioskClockSchema), async (c) => {
    const { kind, clientId, ...credential } = c.req.valid("json");
    const check = await identify(c, credentialOf(credential));
    const event = await kioskClock(c.var.db, c.var.device, check.staff.id, kind, clientId);
    const prompts =
      event.kind === "in" ? await kioskPrompts(kioskContext(c), check.staff, check.pinVerified) : null;
    return c.json(
      {
        firstName: check.staff.firstName,
        kind: event.kind,
        at: event.at,
        repeated: event.repeated,
        prompts,
      },
      201,
    );
  })
  .post("/pin", validate("json", kioskChangePinSchema), async (c) => {
    assertDeviceNotThrottled(c.var.device.id);
    const check = await changeOwnStaffPin(
      c.var.db,
      c.var.staffPinKey,
      c.var.device.workspaceId,
      c.req.valid("json"),
    );
    if (!check.ok) {
      refuse(c.var.device.id, {
        ok: false,
        code:
          check.reason === "inactive"
            ? "staff_inactive"
            : check.reason === "locked"
              ? "pin_locked"
              : "pin_invalid",
        ...(check.reason === "locked" ? { lockedUntil: check.lockedUntil } : {}),
        counts: check.reason !== "inactive",
      });
    }
    return c.json({ firstName: check.staff.firstName });
  })

  // ── After clocking in: SOPs to read and acknowledge (with the prompt token) ──
  .post("/sops/:id/read", validate("param", idParam), validate("json", kioskPromptReadSchema), async (c) =>
    c.json(await kioskReadSop(kioskContext(c), c.req.valid("param").id, c.req.valid("json").promptToken)),
  )
  .post(
    "/sops/:id/acknowledge",
    validate("param", idParam),
    validate("json", kioskAcknowledgeSchema),
    async (c) => {
      const { promptToken, versionId } = c.req.valid("json");
      return c.json(
        await kioskAcknowledgeSop(kioskContext(c), c.req.valid("param").id, promptToken, versionId),
        201,
      );
    },
  )

  // ── Visitors ──
  .get("/hosts", hostSearchLimit, validate("query", kioskHostQuerySchema), async (c) =>
    c.json({ hosts: await searchVisitorHosts(c.var.db, c.var.device.workspaceId, c.req.valid("query").q) }),
  )
  .post("/visitors/sign-in", validate("json", kioskVisitorSignInSchema), async (c) => {
    const done = await signInVisitor(
      c.var.db,
      c.var.device.workspaceId,
      { deviceId: c.var.device.id },
      c.req.valid("json"),
    );
    return c.json(done, 201);
  })
  .post("/visitors/sign-out", validate("json", kioskVisitorSchema), async (c) =>
    c.json(
      await signOutVisitorByName(
        c.var.db,
        c.var.device.workspaceId,
        { deviceId: c.var.device.id },
        c.req.valid("json"),
      ),
    ),
  )

  // ── The offline queue ──
  .post("/replay", validate("json", kioskReplaySchema), async (c) => {
    const deviceId = c.var.device.id;
    const results = await replayOfflineEvents(
      kioskContext(c),
      { throttled: () => isThrottled(deviceId), countFailure: () => countFailure(deviceId) },
      c.req.valid("json"),
    );
    return c.json({ results, at: new Date() });
  });
