import type { NotionRagMcpBindings } from "../worker/bindings";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function isAuthorizedRequest(
  request: Request,
  env: Pick<NotionRagMcpBindings, "MCP_SHARED_SECRET">,
) {
  if (!env.MCP_SHARED_SECRET) {
    return false;
  }
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }
  return await timingSafeEqual(authorization.slice("Bearer ".length), env.MCP_SHARED_SECRET);
}

export async function timingSafeEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (const [index, leftByte] of leftBytes.entries()) {
    difference |= leftByte ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
