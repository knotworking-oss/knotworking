import { expect, it } from "vitest";
import { connect } from "../testing/harness";

it("reads purchase requests through the catalogue without exposing decisions as tools", async () => {
  const session = await connect({
    defaultWorkspace: "acme",
    modules: ["purchase_requests"],
    listMode: "catalogue",
  });
  try {
    const result = await session.call("list_purchase_requests", { view: "assigned" });
    expect(result.isError).toBe(false);
    const [request] = result.data.requests;
    expect(request.status).toBe("pending");
    const detail = await session.call("get_purchase_request", { request_id: request.id });
    expect(detail.isError).toBe(false);
    expect(detail.data).toEqual(request);
    expect((await session.client.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "decide_purchase_request",
    );
  } finally {
    await session.close();
  }
});

it("reads service quotes through the catalogue", async () => {
  const session = await connect({
    defaultWorkspace: "acme",
    modules: ["customers", "tasks", "time", "client_services"],
    listMode: "catalogue",
  });
  try {
    const listed = await session.call("list_service_quotes", { status: "accepted" });
    expect(listed.isError).toBe(false);
    const [quote] = listed.data.quotes;
    const detail = await session.call("get_service_quote", { quote_id: quote.id });
    expect(detail.isError).toBe(false);
    expect(detail.data).toEqual(quote);
  } finally {
    await session.close();
  }
});
