import { StreamableHTTPTransport } from "@hono/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Context } from "hono";

export async function handleNativeMcpRequest<Bindings extends object>(
  context: Context<{ Bindings: Bindings }>,
  createServer: (env: Bindings) => McpServer,
): Promise<Response> {
  const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
  const server = createServer(context.env);
  await server.connect(transport);
  return (await transport.handleRequest(context)) ?? new Response(null, { status: 204 });
}
