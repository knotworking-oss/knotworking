import { describe, expect, it } from "vitest";
import { createMailer, DEFAULT_MAIL_FROM, mailFrom, SMTP_TIMEOUTS } from "./mailer";

describe("mailFrom", () => {
  it("falls back to the default when MAIL_FROM is unset or empty", () => {
    expect(mailFrom({})).toBe(DEFAULT_MAIL_FROM);
    expect(mailFrom({ MAIL_FROM: "" })).toBe(DEFAULT_MAIL_FROM);
    expect(mailFrom({ MAIL_FROM: "Acme <hi@acme.test>" })).toBe("Acme <hi@acme.test>");
  });
});

describe("createMailer", () => {
  it("has finite SMTP timeouts", () => {
    for (const ms of Object.values(SMTP_TIMEOUTS)) expect(ms).toBeGreaterThan(0);
  });

  it("is unconfigured (and only logs) without SMTP_URL", async () => {
    const mailer = createMailer({});
    expect(mailer.configured).toBe(false);
    await expect(mailer.send({ to: "a@b.test", subject: "s", text: "t" })).resolves.toBeUndefined();
  });

  it("rejects instead of hanging when the SMTP server is unreachable", async () => {
    const mailer = createMailer({ SMTP_URL: "smtp://127.0.0.1:1" });
    expect(mailer.configured).toBe(true);
    await expect(mailer.send({ to: "a@b.test", subject: "s", text: "t" })).rejects.toThrow();
  }, 15_000);
});
