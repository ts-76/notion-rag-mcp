import { describe, expect, test, vi } from "vitest";
import { notionRagMcpCloudflareWorker } from "../worker";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

describe("Notion RAG MCP endpoint", () => {
  test("rejects GET stream requests instead of opening a short-lived SSE stream", async () => {
    const response = await notionRagMcpCloudflareWorker.fetch(
      new Request("https://mcp.example.test/mcp", {
        method: "GET",
        headers: { accept: "text/event-stream" },
      }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, DELETE");
  });

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

  test("accepts stateless MCP 2026-07-28 requests", async () => {
    const response = await notionRagMcpCloudflareWorker.fetch(
      jsonRpcRequest(
        {
          id: 3,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "0.0.0" },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
          },
        },
        {
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
        },
      ),
    );
    const payload = (await response.json()) as { readonly result: { readonly tools: unknown[] } };

    expect(response.status).toBe(200);
    expect(payload.result.tools).toHaveLength(6);
  });

  test("advertises MCP 2026-07-28 through server discovery", async () => {
    const response = await notionRagMcpCloudflareWorker.fetch(
      jsonRpcRequest(
        {
          id: 4,
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "0.0.0" },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
          },
        },
        {
          "mcp-method": "server/discover",
          "mcp-protocol-version": "2026-07-28",
        },
      ),
    );
    const payload = (await response.json()) as {
      readonly result: { readonly supportedVersions: readonly string[] };
    };

    expect(response.status).toBe(200);
    expect(payload.result.supportedVersions).toContain("2026-07-28");
  });
});

function jsonRpcRequest(body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  return new Request("https://mcp.example.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
}
