import { afterEach, expect, it } from "vitest";
import { connect } from "../testing/harness";
const sessions: Awaited<ReturnType<typeof connect>>[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});
it("offers a privacy-limited planning read without self-service or HR tools", async () => {
  const s = await connect({ defaultWorkspace: "acme" });
  sessions.push(s);
  const names = (await s.client.listTools()).tools.map((t) => t.name);
  expect(names).toContain("get_workforce_availability");
  expect(names.some((n) => /absence|sickness|leave_request/.test(n))).toBe(false);
  const result = await s.call("get_workforce_availability", { from: "2026-11-15", to: "2026-11-30" });
  expect(result.isError).toBe(false);
  expect(result.data.availability[0].availability).toBe("unavailable");
  expect(Object.keys(result.data.availability[0]).sort()).toEqual([
    "availability",
    "firstName",
    "from",
    "lastName",
    "staffId",
    "staffNumber",
    "to",
  ]);
  expect((await s.call("get_workforce_availability", { from: "2026-11-15", to: "2028-11-30" })).isError).toBe(
    true,
  );
});
it("reads the rota and the staffing check, refusing over-long windows", async () => {
  const s = await connect({ defaultWorkspace: "acme" });
  sessions.push(s);
  const rota = await s.call("get_rota", { from: "2026-11-16", to: "2026-11-22" });
  expect(rota.isError).toBe(false);
  expect(rota.data.entries[0]).toMatchObject({ workDate: "2026-11-16", unavailable: false });
  const staffing = await s.call("get_staffing_check", { from: "2026-11-16", to: "2026-11-16" });
  expect(staffing.data.summary.shortfalls).toBe(1);
  expect((await s.call("get_rota", { from: "2026-11-01", to: "2026-12-31" })).isError).toBe(true);
});
it("hides the tool when the module is not offered", async () => {
  const s = await connect({ defaultWorkspace: "acme", modules: ["people"] });
  sessions.push(s);
  const names = (await s.client.listTools()).tools.map((t) => t.name);
  for (const name of ["get_workforce_availability", "get_rota", "get_staffing_check"])
    expect(names).not.toContain(name);
});
