import { describe, expect, it } from "vitest";
import { demoSettings } from "../scripts/demo-business/settings";

describe("demo loader settings", () => {
  it("defaults to localhost and generates a unique password for a new demo", () => {
    const first = demoSettings({});
    expect(first.base).toBe("http://localhost:3000");
    expect(first.demoPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(demoSettings({}).demoPassword).not.toBe(first.demoPassword);
  });

  it("allows the original generated password on reruns", () => {
    const { demoPassword } = demoSettings({});
    expect(demoSettings({ KNW_DEMO_PASSWORD: demoPassword })).toMatchObject({
      demoPassword,
      generatedPassword: false,
    });
  });

  it("requires explicit opt-in and HTTPS for a remote demo", () => {
    expect(() => demoSettings({ KNW_URL: "https://demo.example" })).toThrow(/KNW_ALLOW_REMOTE/);
    expect(() => demoSettings({ KNW_URL: "http://demo.example", KNW_ALLOW_REMOTE: "1" })).toThrow(/HTTPS/);
    expect(demoSettings({ KNW_URL: "https://demo.example", KNW_ALLOW_REMOTE: "1" }).base).toBe(
      "https://demo.example",
    );
  });

  it("rejects credentials embedded in a target URL and the old public demo password", () => {
    expect(() => demoSettings({ KNW_URL: "https://user:pass@localhost" })).toThrow(/origin/);
    expect(() => demoSettings({ KNW_DEMO_PASSWORD: "knotworking-demo" })).toThrow(/32-character/);
  });
});
