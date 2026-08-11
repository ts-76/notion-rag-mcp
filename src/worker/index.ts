import type { NotionRagMcpBindings } from "./bindings";
import { createNotionRagMcpHonoApp, startScheduledNotionReindexes } from "../app/create-app";

export {
  createNotionRagMcpHonoApp,
  notionRagMcpApp,
  NotionIndexWorkItemWorkflow,
  NotionReindexWorkflow,
} from "../app/create-app";

type ScheduledExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

const notionRagMcpHonoApp = createNotionRagMcpHonoApp();

export const notionRagMcpCloudflareWorker = {
  async fetch(request: Request, env: NotionRagMcpBindings = {}): Promise<Response> {
    return notionRagMcpHonoApp.fetch(request, env);
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
