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

  // This Worker creates a fresh stateless transport for every request, so it cannot keep a
  // server-initiated SSE stream alive. Returning a short-lived stream makes MCP clients reconnect
  // continuously; explicitly reject stream requests as allowed by the MCP specification.
  if (request.method === "GET") {
    return new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } });
  }

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
