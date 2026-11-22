import { Api, type Ctx } from "./api";

type Level = "none" | "read" | "write" | "manage";
const ALL = "all";

// email, name, role, title, department, reports to (email), staff record, default level for modules ("all") + overrides
export const team: {
  email: string;
  name: string;
  role: "admin" | "member";
  title: string;
  department: string;
  reportsTo?: string;
  access: Record<string, Level>;
}[] = [
  {
    email: "eleanor@knotmilk.example",
    name: "Eleanor Whitcombe",
    role: "admin",
    title: "Managing Director",
    department: "Management",
    access: { [ALL]: "manage" },
  },
  {
    email: "rhys@knotmilk.example",
    name: "Rhys Pritchard",
    role: "admin",
    title: "Operations Manager",
    department: "Operations",
    reportsTo: "eleanor@knotmilk.example",
    access: { [ALL]: "manage" },
  },
  {
    email: "hannah@knotmilk.example",
    name: "Hannah Okafor",
    role: "admin",
    title: "Technical Manager",
    department: "Technical",
    reportsTo: "eleanor@knotmilk.example",
    access: { [ALL]: "manage" },
  },
  {
    email: "callum@knotmilk.example",
    name: "Callum Brennan",
    role: "member",
    title: "Production Manager",
    department: "Production",
    reportsTo: "rhys@knotmilk.example",
    access: {
      [ALL]: "write",
      production: "manage",
      recipes: "write",
      stock: "manage",
      demand: "write",
      attendance: "write",
      people: "read",
    },
  },
  {
    email: "priya.d@knotmilk.example",
    name: "Priya Desai",
    role: "member",
    title: "Finance Manager",
    department: "Finance",
    reportsTo: "eleanor@knotmilk.example",
    access: {
      [ALL]: "read",
      purchasing: "manage",
      costing: "manage",
      sales: "write",
      accounting: "manage",
      bi: "manage",
      workforce_hr: "none",
    },
  },
  {
    email: "naomi@knotmilk.example",
    name: "Naomi Clarke",
    role: "member",
    title: "Sales Manager",
    department: "Sales",
    reportsTo: "eleanor@knotmilk.example",
    access: { [ALL]: "read", sales: "manage", customers: "manage", despatch: "write", demand: "write" },
  },
  {
    email: "colin@knotmilk.example",
    name: "Colin Marsh",
    role: "member",
    title: "Purchasing Buyer",
    department: "Purchasing",
    reportsTo: "rhys@knotmilk.example",
    access: { [ALL]: "read", purchasing: "manage", items: "write", stock: "write" },
  },
];

export async function members(ctx: Ctx) {
  const { api } = ctx;
  const userId = (ctx.ids.user ??= {});
  let made = 0;
  const list = async () => (await api.get("/members")).members as any[];
  let current = await list();
  const meId = current.find((m) => m.role === "owner")?.userId;
  userId["owner"] = meId;

  // Check existing demo accounts before creating invitations or changing profiles.
  // A different password on a rerun must not lead to a partially configured load.
  for (const t of team) {
    if (!current.some((member) => member.email === t.email)) continue;
    try {
      await loginAs(ctx, t.email);
    } catch {
      throw new Error(
        `Cannot sign in as ${t.email}. Use the original KNW_DEMO_PASSWORD or a fresh demo instance.`,
      );
    }
  }

  for (const t of team) {
    let m = current.find((x) => x.email === t.email);
    if (!m) {
      const inv = await api.post("/invitations", { email: t.email, role: t.role });
      const token = String(inv.url).split("/invite/")[1]!;
      const res = await fetch(`${api.base}/api/v1/public/invitations/${token}/accept`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", origin: api.base },
        body: JSON.stringify({ name: t.name, password: ctx.demoPassword }),
      });
      if (!res.ok) throw new Error(`accept ${t.email}: ${res.status} ${await res.text()}`);
      current = await list();
      m = current.find((x) => x.email === t.email)!;
      made++;
    }
    userId[t.email] = m.userId;
  }
  const modulesList = ((await api.get("/members/module-access")).modules as any[]).map((m) => m.id as string);
  for (const t of team) {
    await api.patch(`/members/${userId[t.email]}/profile`, {
      title: t.title,
      department: t.department,
      reportsToUserId: t.reportsTo ? userId[t.reportsTo] : null,
    });
    if (t.role === "admin") continue; // owners and admins always have full access
    for (const mod of modulesList) {
      const level = t.access[mod] ?? t.access[ALL] ?? "read";
      await api.put(`/members/${userId[t.email]}/module-access/${mod}`, { level });
    }
  }
  // Existing demo members: give them department context too.
  return `${made} members created`;
}

/** Sign in as another member (used for four-eyes approvals). */
const sessions = new Map<string, Api>();
export async function loginAs(ctx: Ctx, email: string) {
  const cached = sessions.get(email);
  if (cached) return cached;
  const a = new Api(ctx.api.base, ctx.api.slug);
  await a.login(email, ctx.demoPassword);
  sessions.set(email, a);
  return a;
}
