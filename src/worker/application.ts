import { createNotionRagMcpHonoApp } from "../app/create-app";
import type { NotionRagMcpBindings } from "./bindings";

const notionRagMcpHonoApp = createNotionRagMcpHonoApp();

export const notionRagMcpApplicationWorker = {
  async fetch(request: Request, env: NotionRagMcpBindings = {}): Promise<Response> {
    return await notionRagMcpHonoApp.fetch(request, env);
  },
};
