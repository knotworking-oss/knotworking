import { readFileSync } from "node:fs";
import { newId, RESERVED_WORKSPACE_SLUGS } from "@knotworking/core";
import { eq, sql as dsql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder } from "./migrate";
import { syncChanges, workspaces } from "./schema";

const FILE = "0007_reserved_workspace_slugs.sql";
const sql = readFileSync(`${migrationsFolder}/${FILE}`, "utf8");
const raw = (text: string) => dsql.raw(text); // plain SQL through drizzle

/** The workspace columns these migrations know (later ones, such as `time_zone`, don't exist yet). */
const columnsBefore0007 = {
  id: workspaces.id,
  slug: workspaces.slug,
  name: workspaces.name,
  icon: workspaces.icon,
  createdAt: workspaces.createdAt,
  updatedAt: workspaces.updatedAt,
  deletedAt: workspaces.deletedAt,
};

/** Applies every migration before 0007 (in journal order), so rows can be seeded under the old rules. */
async function dbBefore0007() {
  const handle = createDb("memory://");
  const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8")) as {
    entries: { tag: string }[];
  };
  for (const { tag } of journal.entries) {
    if (tag === FILE.replace(".sql", "")) break;
    const text = readFileSync(`${migrationsFolder}/${tag}.sql`, "utf8");
    for (const statement of text.split("--> statement-breakpoint")) {
      if (statement.trim()) await handle.db.execute(raw(statement));
    }
  }
  return handle;
}

function inlineList(text: string): string[] {
  const body = text.split("-- reserved-slugs:begin")[1]?.split("-- reserved-slugs:end")[0];
  if (body === undefined) throw new Error("reserved-slugs markers missing from the migration");
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** Every migration that carries a reserved-slug list, in journal order (0007, then later additions). */
function reservedSlugMigrations() {
  const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8")) as {
    entries: { tag: string }[];
  };
  return journal.entries
    .map(({ tag }) => ({ tag, text: readFileSync(`${migrationsFolder}/${tag}.sql`, "utf8") }))
    .filter(({ text }) => text.includes("-- reserved-slugs:begin"));
}

describe("reserved-slug migrations", () => {
  it("the latest carries exactly RESERVED_WORKSPACE_SLUGS inline (fails if the lists drift)", () => {
    const all = reservedSlugMigrations();
    const latest = inlineList(all.at(-1)!.text);
    expect([...latest].sort()).toEqual([...RESERVED_WORKSPACE_SLUGS].sort());
    expect(new Set(latest).size).toBe(latest.length);
    // Each list only ever grows: a slug reserved once stays reserved.
    for (let i = 1; i < all.length; i++) {
      const before = inlineList(all[i - 1]!.text);
      expect(inlineList(all[i]!.text)).toEqual(expect.arrayContaining(before));
    }
  });

  it("0022 renames a workspace called kiosk", async () => {
    const handle = createDb("memory://");
    try {
      const { migrateDb } = await import("./migrate");
      await migrateDb(handle);
      const later = readFileSync(`${migrationsFolder}/0022_reserve_kiosk_slug.sql`, "utf8");
      const [ws] = await handle.db
        .insert(workspaces)
        .values({ slug: "kiosk", name: "Kiosk Ltd" })
        .returning();
      await handle.db.execute(raw(later));
      const [row] = await handle.db
        .select(columnsBefore0007)
        .from(workspaces)
        .where(eq(workspaces.id, ws!.id));
      expect(row!.slug).toBe("kiosk-workspace");
    } finally {
      await handle.close();
    }
  }, 60_000);
});

describe(`migration ${FILE}`, () => {
  it("renames existing reserved slugs, avoids collisions (including soft-deleted rows) and logs the change", async () => {
    const handle = await dbBefore0007();
    try {
      const { db } = handle;
      // Plain SQL: the schema's later columns (such as `time_zone`) don't exist before 0007.
      const insert = async (slug: string, extra: { deletedAt?: Date } = {}) => {
        const id = newId();
        await db.execute(
          dsql`insert into workspaces (id, slug, name, deleted_at) values (${id}, ${slug}, ${`ws ${slug}`}, ${extra.deletedAt?.toISOString() ?? null})`,
        );
        return id;
      };

      const api = await insert("api");
      const mcp = await insert("mcp");
      const mixed = await insert("Login");
      const taken = await insert("v1");
      await insert("v1-workspace");
      await insert("v1-workspace-2", { deletedAt: new Date() }); // soft-deleted rows still hold their slug
      const deleted = await insert("admin", { deletedAt: new Date() });
      const fine = await insert("acme");
      const fallback = await insert("workspace");

      for (const statement of sql.split("--> statement-breakpoint")) await db.execute(raw(statement));

      const slugOf = async (id: string) =>
        (await db.select({ slug: workspaces.slug }).from(workspaces).where(eq(workspaces.id, id)))[0]!.slug;
      expect(await slugOf(api)).toBe("api-workspace");
      expect(await slugOf(mcp)).toBe("mcp-workspace");
      expect(await slugOf(mixed)).toBe("login-workspace");
      expect(await slugOf(taken)).toBe("v1-workspace-3");
      expect(await slugOf(deleted)).toBe("admin-workspace");
      expect(await slugOf(fine)).toBe("acme");
      expect(await slugOf(fallback)).toBe("workspace");

      const all = await db.select({ slug: workspaces.slug }).from(workspaces);
      for (const { slug } of all) expect(RESERVED_WORKSPACE_SLUGS).not.toContain(slug);

      // Live renamed workspaces get a `workspace` upsert; untouched and soft-deleted ones do not.
      const logged = await db.select().from(syncChanges);
      expect(logged.map((l) => l.entityId).sort()).toEqual([api, mcp, mixed, taken].sort());
      const apiChange = logged.find((l) => l.entityId === api)!;
      expect(apiChange).toMatchObject({ workspaceId: api, entity: "workspace", action: "upsert" });
      expect(apiChange.data).toMatchObject({
        id: api,
        slug: "api-workspace",
        name: "ws api",
        icon: null,
        deletedAt: null,
      });
      const [row] = await db.select(columnsBefore0007).from(workspaces).where(eq(workspaces.id, api));
      expect((apiChange.data as { updatedAt: string }).updatedAt).toBe(row!.updatedAt.toISOString());
      expect((apiChange.data as { createdAt: string }).createdAt).toBe(row!.createdAt.toISOString());
    } finally {
      await handle.close();
    }
  }, 60_000);

  it("is a no-op when nothing is reserved", async () => {
    const handle = await dbBefore0007();
    try {
      await handle.db.execute(
        dsql`insert into workspaces (id, slug, name) values (${newId()}, 'acme', 'Acme')`,
      );
      for (const statement of sql.split("--> statement-breakpoint")) await handle.db.execute(raw(statement));
      expect((await handle.db.select(columnsBefore0007).from(workspaces)).map((w) => w.slug)).toEqual([
        "acme",
      ]);
      expect(await handle.db.select().from(syncChanges)).toEqual([]);
    } finally {
      await handle.close();
    }
  }, 60_000);
});
