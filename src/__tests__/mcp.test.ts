import { describe, expect, test, vi } from "vitest";
import { notionRagMcpCloudflareWorker } from "../worker";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

describe("Notion RAG MCP endpoint", () => {
  test("does not require a Worker-level shared secret", async () => {
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
    );

    expect(initialize.status).toBe(200);
    await expect(initialize.json()).resolves.toMatchObject({
      result: { serverInfo: { name: "notion-rag-mcp" } },
    });
  });

  test("publishes only the standalone Notion RAG tools", async () => {
    const response = await notionRagMcpCloudflareWorker.fetch(
      jsonRpcRequest({ id: 2, method: "tools/list", params: {} }),
    );
    const payload = (await response.json()) as {
      readonly result: { readonly tools: { name: string }[] };
    };

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

function jsonRpcRequest(body: Record<string, unknown>) {
  return new Request("https://mcp.example.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
}
