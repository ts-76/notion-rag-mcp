import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { NotionRagMcpBindings } from "./bindings";
import { startScheduledNotionReindexes } from "../app/create-app";
import { handleAccessRequest } from "../features/mcp/access-oauth-handler";
import { notionRagMcpApplicationWorker } from "./application";

export {
  createNotionRagMcpHonoApp,
  notionRagMcpApp,
  NotionIndexWorkItemWorkflow,
  NotionReindexWorkflow,
} from "../app/create-app";

type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};

type ScheduledExecutionContext = Pick<WorkerExecutionContext, "waitUntil">;

export { notionRagMcpApplicationWorker } from "./application";

const oauthProvider = new OAuthProvider({
  apiHandler: notionRagMcpApplicationWorker,
  apiRoute: ["/mcp", "/sources", "/reindex-jobs"],
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: {
    fetch: (request: Request, env: NotionRagMcpBindings, context: WorkerExecutionContext) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/authorize" || pathname === "/callback") {
        return handleAccessRequest(request, env as Parameters<typeof handleAccessRequest>[1], context);
      }
      return notionRagMcpApplicationWorker.fetch(request, env);
    },
  },
  tokenEndpoint: "/token",
});

export const notionRagMcpCloudflareWorker = {
  async fetch(
    request: Request,
    env: NotionRagMcpBindings,
    context: WorkerExecutionContext,
  ): Promise<Response> {
    return oauthProvider.fetch(request, env, context);
  },
  async scheduled(
    _controller: unknown,
    env: NotionRagMcpBindings = {},
    context: ScheduledExecutionContext,
  ): Promise<void> {
    context.waitUntil(startScheduledNotionReindexes(env));
  },
};

export default notionRagMcpCloudflareWorker;
