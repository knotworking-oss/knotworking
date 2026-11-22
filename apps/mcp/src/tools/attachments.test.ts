import { newId } from "@knotworking/core";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "../testing/harness";

type Session = Awaited<ReturnType<typeof connect>>;
const open: Session[] = [];
async function session(options: Parameters<typeof connect>[0] = {}) {
  const s = await connect(options);
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("record attachment tools", () => {
  it("lists a supplier's files as metadata only, with the record's lock state", async () => {
    const { call, fake } = await session();
    const supplier = newId();
    fake.store.attachmentRecords[supplier] = { locked: true };
    fake.store.attachments.push({
      id: newId(),
      uploaderId: fake.ids.grace,
      taskId: null,
      documentId: null,
      entityType: "supplier",
      entityId: supplier,
      kind: "certificate",
      filename: "BRCGS.pdf",
      contentType: "application/octet-stream",
      size: 1234,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    const res = await call("list_items_record_attachments", { record_type: "supplier", record: supplier });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ recordType: "supplier", locked: true, total: 1 });
    expect(res.data.attachments).toEqual([
      {
        id: expect.any(String),
        filename: "BRCGS.pdf",
        kind: "certificate",
        contentType: "application/octet-stream",
        sizeBytes: 1234,
        uploaderId: fake.ids.grace,
        createdAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(res.data)).not.toMatch(/storageKey|"url"/i);
    expect(fake.requests.some((r) => r.path.endsWith("/content"))).toBe(false);
  });

  it("is read-only, scoped to its module's record types, and reports a missing record", async () => {
    const { client, call } = await session();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "list_quality_record_attachments")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect((tool.inputSchema as any).properties.record_type.enum).toEqual([
      "quality_complaint",
      "quality_nonconformance",
      "quality_audit",
      "quality_recall_test",
    ]);
    expect(
      (await call("list_quality_record_attachments", { record_type: "supplier", record: newId() })).isError,
    ).toBe(true);
    const missing = await call("list_quality_record_attachments", {
      record_type: "quality_complaint",
      record: newId(),
    });
    expect(missing.data.error.code).toBe("not_found");
  });

  it("gives a short-lived signed link for a listed file, not its bytes", async () => {
    const { call, fake } = await session();
    const id = newId();
    fake.store.attachments.push({
      id,
      uploaderId: fake.ids.grace,
      taskId: null,
      documentId: null,
      entityType: "supplier",
      entityId: newId(),
      kind: "certificate",
      filename: "BRCGS.pdf",
      contentType: "application/pdf",
      size: 1234,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    const res = await call("get_attachment_link", { attachment: id });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({
      filename: "BRCGS.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      url: expect.stringContaining("/api/v1/public/attachment-links/"),
      expiresAt: expect.any(String),
    });
    // Asking is all it does: the bytes are never fetched through the server.
    expect(fake.requests.some((r) => r.path.endsWith("/content"))).toBe(false);
    expect((await call("get_attachment_link", { attachment: newId() })).data.error.code).toBe("not_found");
  });

  it("is read-only and offered whichever modules are readable", async () => {
    const { client } = await session();
    const tool = (await client.listTools()).tools.find((t) => t.name === "get_attachment_link")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});
