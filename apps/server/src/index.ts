import { AssistantHub } from "./assistant-hub";
import { startNotificationEmailWorker } from "./services/notifications";
import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { createDb } from "@knotworking/db";
import { createApp } from "./app";
import { createAuth, enabledProviders } from "./auth";
import { createCalendarDeps } from "./calendar";
import { startCalendarScheduler } from "./calendar/scheduler";
import { startNotificationSweep } from "./services/notification-sweep";
import { startAccountingDispatcher } from "./accounting/dispatcher";
import { createXeroConnectionService } from "./accounting/xero-connection";
import { createAccountingAdapterRegistry } from "./accounting/registry";
import { needsSetup } from "./services/setup";
import { loadConfig } from "./config";
import { createMailer } from "./mailer";
import { createStorage } from "./storage";

const config = loadConfig();
const handle = createDb();
const mailer = createMailer();
const auth = createAuth({ db: handle.db, mailer, ...config });
// Calendar sync is behind the `calendar` module flag: with it off no provider is wired, so nothing
// polls Google or Microsoft and the connection routes stay shut.
const calendar = createCalendarDeps(handle.db, auth, config.activeModules.includes("calendar") ? config : {});
const storage = createStorage(config.uploads.storage);

// First-run setup needs a one-time code from this log, so whoever reaches a
// fresh install first can't claim it.
const setupToken = (await needsSetup(handle.db))
  ? process.env.SETUP_TOKEN || randomBytes(18).toString("base64url")
  : undefined;
const assistantHub = new AssistantHub(handle.db);
const xero =
  config.xero && config.activeModules.includes("accounting")
    ? createXeroConnectionService(handle.db, { ...config.xero, appUrl: config.appUrl, secret: config.secret })
    : undefined;
const accountingAdapters = createAccountingAdapterRegistry(xero ? { xero: xero.adapter } : {});
const app = createApp({
  assistantHub,
  assistantMcpUrl: config.assistantMcpUrl,
  db: handle.db,
  auth,
  mailer,
  appUrl: config.appUrl,
  trustedOrigins: config.trustedOrigins,
  providers: enabledProviders(config),
  calendar,
  setupToken,
  apiTokenRateLimit: config.apiTokenRateLimit,
  storage,
  uploadMaxBytes: config.uploads.maxBytes,
  activeModules: config.activeModules,
  secret: config.secret,
  accountingAdapters,
  xero,
  log: true,
});

const stopCalendar = Object.keys(calendar.providers).length
  ? startCalendarScheduler(calendar, config.calendarSyncIntervalMs)
  : () => {};

const stopSweep = config.notificationSweepIntervalMs
  ? startNotificationSweep(handle.db, {
      activeModules: config.activeModules,
      intervalMs: config.notificationSweepIntervalMs,
    })
  : () => {};

const stopEmails = startNotificationEmailWorker(handle.db);

const accountingDispatch =
  config.activeModules.includes("accounting") &&
  accountingAdapters.providers.length > 0 &&
  config.accountingDispatchIntervalMs > 0;
const stopAccounting = accountingDispatch
  ? startAccountingDispatcher(handle.db, accountingAdapters, {
      intervalMs: config.accountingDispatchIntervalMs,
    })
  : () => {};

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.hostname }, (info) => {
  console.log(`▲ Knotworking API listening on http://localhost:${info.port} (${handle.driver})`);
  console.log(`  public URL ${config.appUrl} · email ${mailer.configured ? "SMTP" : "logged to console"}`);
  console.log(`  modules ${config.activeModules.join(", ") || "none (platform only)"}`);
  const up = config.uploads;
  console.log(
    `  uploads ${up.storage.kind === "s3" ? `S3 bucket ${up.storage.bucket}` : `on disk at ${up.storage.dir}`} · max ${Math.round(up.maxBytes / 1024 / 1024)} MB`,
  );
  if (setupToken)
    console.log(`\n  ➜ Finish setting up Knotworking: ${config.appUrl}/setup?token=${setupToken}\n`);
  const cal = Object.keys(calendar.providers);
  console.log(
    `  due-date notifications ${config.notificationSweepIntervalMs ? `every ${config.notificationSweepIntervalMs / 1000}s` : "off"}`,
  );
  if (config.activeModules.includes("accounting"))
    console.log(
      `  accounting dispatch ${accountingDispatch ? `every ${config.accountingDispatchIntervalMs / 1000}s` : "off"}`,
    );
  console.log(
    `  calendar sync ${cal.length ? `${cal.join(" + ")} every ${config.calendarSyncIntervalMs / 1000}s` : "off (no Google/Microsoft OAuth configured)"}`,
  );
});

const shutdown = async () => {
  // End running assistant replies (and revoke their tokens) before the database closes.
  await assistantHub.drain();
  assistantHub.stop();
  stopCalendar();
  stopSweep();
  stopAccounting();
  await stopEmails();
  server.close();
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
