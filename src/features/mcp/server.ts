import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { NotionRagMcpBindings } from "../../worker/bindings";
import { getNotionReindexStatus, startNotionReindex } from "../management/reindex";
import { listNotionSources, upsertNotionSource } from "../management/sources";
import { getIndexedNotionPage } from "../retrieval/page-service";
import { searchIndexedNotion } from "../retrieval/search-service";

export function createNotionRagMcpServer(env: NotionRagMcpBindings) {
  const server = new McpServer({ name: "notion-rag-mcp", version: "0.1.0" });
  server.registerTool(
    "notion_search",
    {
      title: "Search indexed Notion",
      description: "Search indexed Notion pages with hybrid semantic, FTS, and keyword retrieval.",
      inputSchema: z.object({
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(20).optional(),
      }),
    },
    async ({ query, limit }) =>
      toolResult(
        await searchIndexedNotion({ env, query, ...(limit === undefined ? {} : { limit }) }),
      ),
  );
  server.registerTool(
    "notion_get_page",
    {
      title: "Get indexed Notion page",
      description: "Read an indexed page without calling the Notion API at query time.",
      inputSchema: z.object({ pageId: z.string().min(1).max(64) }),
    },
    async ({ pageId }) => toolResult(await getIndexedNotionPage(env, pageId)),
  );
  server.registerTool(
    "notion_source_upsert",
    {
      title: "Add or update Notion source",
      description: "Register a root Notion page as an index source. The integration must have access to the page.",
      inputSchema: z.object({
        pageId: z.string().min(1).max(64),
        name: z.string().min(1).max(200).optional(),
      }),
    },
    async ({ pageId, name }) =>
      toolResult(await upsertNotionSource({ env, pageId, ...(name === undefined ? {} : { name }) })),
  );
  server.registerTool(
    "notion_source_list",
    {
      title: "List Notion sources",
      description: "List registered Notion RAG sources.",
      inputSchema: z.object({}),
    },
    async () => toolResult(await listNotionSources(env)),
  );
  server.registerTool(
    "notion_reindex_start",
    {
      title: "Start Notion reindex",
      description: "Start a durable reindex workflow for a registered source.",
      inputSchema: z.object({ sourceId: z.string().min(1).max(128) }),
    },
    async ({ sourceId }) => toolResult(await startNotionReindex(env, sourceId)),
  );
  server.registerTool(
    "notion_reindex_status",
    {
      title: "Get Notion reindex status",
      description: "Read the current durable Workflow status of a reindex job.",
      inputSchema: z.object({ jobId: z.string().min(1).max(200) }),
    },
    async ({ jobId }) => toolResult(await getNotionReindexStatus(env, jobId)),
  );
  return server;
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
