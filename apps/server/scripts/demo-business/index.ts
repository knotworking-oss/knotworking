/**
 * Loads a complete, realistic mock business (Knotmilk Dairy) into a running Knotworking install
 * through its HTTP API. Idempotent: records are matched by code/name and skipped if present.
 *
 *   KNW_URL=http://localhost:3000 KNW_SLUG=knotmilk KNW_EMAIL=… KNW_PASSWORD=… \
 *     pnpm --filter @knotworking/server demo:business
 */
import { Api, step, type Ctx } from "./api";
import { demoSettings } from "./settings";
import { foundation } from "./foundation";
import { members } from "./team";
import { commercial, purchasing } from "./commercial";
import { production } from "./production";
import { sales } from "./sales";
import { qms, specifications } from "./qms";
import { quality } from "./quality";
import { haccp } from "./haccp";
import { site } from "./site";
import { testing } from "./testing";
import { workforce } from "./workforce";
import { attendance } from "./attendance";
import { hse, hseIncidents } from "./hse";
import { governance } from "./governance";
import { labelling, npd, defence } from "./compliance";
import { finance } from "./finance";
import { work } from "./work";
import { supplierControls, stockHygiene } from "./controls";
import { bi, authenticity } from "./bi";

const { base, demoPassword, generatedPassword } = demoSettings(process.env);
const slug = process.env.KNW_SLUG ?? "knotmilk";
const email = process.env.KNW_EMAIL;
const password = process.env.KNW_PASSWORD;
if (!email || !password) throw new Error("Set KNW_EMAIL and KNW_PASSWORD (a workspace owner).");

const api = new Api(base, slug);
await api.login(email, password);
if (generatedPassword) console.log(`Demo member password (save privately for reruns): ${demoPassword}`);
const ctx: Ctx = { api, demoPassword, today: new Date().toISOString().slice(0, 10), ids: {} };

const only = process.env.KNW_ONLY?.split(",");
const waves: [string, (c: Ctx) => Promise<unknown>][] = [
  ["foundation", foundation],
  ["commercial", commercial],
  ["purchasing", purchasing],
  ["production", production],
  ["sales", sales],
  ["qms", qms],
  ["specifications", specifications],
  ["quality", quality],
  ["haccp", haccp],
  ["site", site],
  ["testing", testing],
  ["workforce", workforce],
  ["attendance", attendance],
  ["hse", hse],
  ["hseIncidents", hseIncidents],
  ["governance", governance],
  ["labelling", labelling],
  ["npd", npd],
  ["defence", defence],
  ["finance", finance],
  ["work", work],
  ["supplierControls", supplierControls],
  ["stockHygiene", stockHygiene],
  ["bi", bi],
  ["authenticity", authenticity],
];
await members(ctx);
for (const [name, fn] of waves)
  if (["foundation", "commercial", "haccp", "qms"].includes(name) || !only || only.includes(name))
    await step(name, () => fn(ctx));
