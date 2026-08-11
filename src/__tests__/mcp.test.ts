import { describe, expect, test, vi } from "vitest";
import { notionRagMcpCloudflareWorker } from "../worker";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

describe("Notion RAG MCP endpoint", () => {
  test("fails closed when the MCP secret is not configured", async () => {
    const response = await notionRagMcpCloudflareWorker.fetch(jsonRpcRequest({ id: 1, method: "tools/list" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "not_configured",
      reason: "mcp_shared_secret_missing",
    });
  });

  test("rejects a missing bearer token", async () => {
    const response = await notionRagMcpCloudflareWorker.fetch(
      jsonRpcRequest({ id: 1, method: "tools/list" }, false),
      { MCP_SHARED_SECRET: "test-secret" },
    );

    expect(response.status).toBe(401);
  });

  test("publishes only the standalone Notion RAG tools", async () => {
    const env = { MCP_SHARED_SECRET: "test-secret" };
    const initialize = await notionRagMcpCloudflareWorker.fetch(
      jsonRpcRequest({
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "vitest", version: "0.0.0" },
        },
      }),
      env,
    );

    expect(initialize.status).toBe(200);
    await expect(initialize.json()).resolves.toMatchObject({
      result: { serverInfo: { name: "notion-rag-mcp" } },
    });

    const response = await notionRagMcpCloudflareWorker.fetch(
      jsonRpcRequest({ id: 2, method: "tools/list", params: {} }),
      env,
    );
    const payload = (await response.json()) as { readonly result: { readonly tools: { name: string }[] } };

    expect(response.status).toBe(200);
    expect(payload.result.tools.map((tool) => tool.name).sort()).toEqual([
      "notion_get_page",
      "notion_reindex_start",
      "notion_reindex_status",
      "notion_search",
      "notion_source_list",
      "notion_source_upsert",
    ]);
  });
});

function jsonRpcRequest(body: Record<string, unknown>, includeAuthorization = true) {
  return new Request("https://mcp.example.test/mcp", {
    method: "POST",
    headers: {
      ...(includeAuthorization ? { authorization: "Bearer test-secret" } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
}
