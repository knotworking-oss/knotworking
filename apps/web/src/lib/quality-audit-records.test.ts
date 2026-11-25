import { afterEach, expect, it, vi } from "vitest";
import { getQualityAuditRecords } from "./api";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

afterEach(() => vi.unstubAllGlobals());

it.each(["none", "read"] as const)("loads audit records when Stock access is %s", async (access) => {
  const fetch = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/bootstrap")) return Response.json({ modules: [{ id: "stock", access }] });
    if (path.endsWith("/quality/audits")) return Response.json({ audits: [{ id: "audit" }] });
    if (access === "read" && path.endsWith("/quality/recall-tests")) {
      return Response.json({ recallTests: [{ id: "recall" }] });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  await expect(getQualityAuditRecords("acme")).resolves.toEqual({
    audits: [{ id: "audit" }],
    recallTests: access === "read" ? [{ id: "recall" }] : null,
  });
});
