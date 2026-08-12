import {
  createMcpHandler,
  isLegacyRequest,
  type McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { Context } from "hono";

export async function handleNativeMcpRequest<Bindings extends object>(
  context: Context<{ Bindings: Bindings }>,
  createServer: (env: Bindings) => McpServer,
): Promise<Response> {
  const request = context.req.raw;
  if (await isLegacyRequest(request)) {
    // Preserve JSON-only responses for 2025-era clients while the v2 handler serves 2026 requests.
    return await handleLegacyMcpRequest(request, context.env, createServer);
  }
  const handler = createMcpHandler(() => createServer(context.env), {
    legacy: "reject",
  });
  return await handler.fetch(request);
}

async function handleLegacyMcpRequest<Bindings extends object>(
  request: Request,
  env: Bindings,
  createServer: (env: Bindings) => McpServer,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createServer(env);
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
