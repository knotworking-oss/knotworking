import { readFileSync } from "node:fs";
import { newId } from "@knotworking/core";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder } from "./migrate";
import { notifications } from "./schema";

describe("information-flow migration", () => {
  it("skips historical inbox email while new notifications enter the durable queue", async () => {
    const handle = createDb("memory://");
    try {
      const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8")) as {
        entries: { tag: string }[];
      };
      const apply = async (tag: string) => {
        for (const statement of readFileSync(`${migrationsFolder}/${tag}.sql`, "utf8").split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim()) await handle.db.execute(sql.raw(statement));
        }
      };
      for (const { tag } of journal.entries) {
        if (tag === "0055_module_information_flow") break;
        await apply(tag);
      }
      const userId = newId(),
        workspaceId = newId(),
        oldId = newId();
      await handle.db.execute(
        sql`insert into users (id, email, name) values (${userId}, 'upgrade@example.test', 'Upgrade')`,
      );
      await handle.db.execute(
        sql`insert into workspaces (id, slug, name) values (${workspaceId}, 'upgrade', 'Upgrade')`,
      );
      await handle.db.execute(
        sql`insert into notifications (id, workspace_id, user_id, type, data) values (${oldId}, ${workspaceId}, ${userId}, 'task_assigned', '{}')`,
      );
      await apply("0055_module_information_flow");
      const [historical] = await handle.db.select().from(notifications).where(eq(notifications.id, oldId));
      expect(historical?.emailState).toBe("skipped");
      const [fresh] = await handle.db
        .insert(notifications)
        .values({ workspaceId, userId, type: "task_assigned", data: { taskTitle: "New" } })
        .returning();
      expect(fresh).toMatchObject({ emailState: "pending", emailAttempts: 0, emailLeaseToken: null });
    } finally {
      await handle.close();
    }
  }, 60_000);
});
