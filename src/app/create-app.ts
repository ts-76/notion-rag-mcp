import { Hono } from "hono";
import { isAuthorizedRequest, jsonResponse } from "../lib/http";
import { handleNativeMcpRequest } from "../lib/native-mcp";
import type {
  NotionRagMcpBindings,
  NotionIndexWorkItemWorkflowPayload,
  NotionReindexWorkflowPayload,
} from "../worker/bindings";
import {
  executeNotionWorkflowStep,
  repairNotionSourceVectors,
  runNotionIndexWorkItemWorkflow,
  runNotionReindexWorkflow,
} from "../features/indexing/indexer";
import { auditNotionSourceIndex } from "../features/indexing/audit";
import { getNotionReindexStatus, startNotionReindex } from "../features/management/reindex";
import { listNotionSources, upsertNotionSource } from "../features/management/sources";
import { createNotionRagMcpServer } from "../features/mcp/server";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export const notionRagMcpApp = {
  name: "notion-rag-mcp",
  responsibility: "MCP transport plus Notion traversal, indexing, and hybrid RAG retrieval",
} as const;

const internalServiceHostname = "notion-rag-mcp.internal";

export { startScheduledNotionReindexes } from "../features/indexing/indexer";

export function createNotionRagMcpHonoApp() {
  const app = new Hono<{ Bindings: NotionRagMcpBindings }>();
  app.get("/health", () => jsonResponse({ status: "ok", app: notionRagMcpApp.name }));
  app.all("/mcp", async (context) => {
    const authorization = await requirePublicAuthorization(context.req.raw, context.env);
    if (authorization) {
      return authorization;
    }
    return await handleNativeMcpRequest(context, createNotionRagMcpServer);
  });
  app.get("/sources", async (context) => {
    const authorization = await requirePublicAuthorization(context.req.raw, context.env);
    return authorization ?? jsonResponse(await listNotionSources(context.env));
  });
  app.put("/sources/:pageId", async (context) => {
    const authorization = await requirePublicAuthorization(context.req.raw, context.env);
    if (authorization) {
      return authorization;
    }
    let name: string | undefined;
    try {
      const body = await context.req.json<{ name?: unknown }>();
      name = typeof body.name === "string" ? body.name : undefined;
    } catch {
      return jsonResponse({ status: "bad_request", reason: "invalid_json" }, 400);
    }
    return jsonResponse(
      await upsertNotionSource({
        env: context.env,
        pageId: context.req.param("pageId"),
        ...(name === undefined ? {} : { name }),
      }),
    );
  });
  app.post("/sources/:sourceId/reindex", async (context) => {
    const authorization = await requirePublicAuthorization(context.req.raw, context.env);
    return authorization ?? jsonResponse(await startNotionReindex(context.env, context.req.param("sourceId")));
  });
  app.post("/internal/workflow-step", async (context) => {
    if (new URL(context.req.url).hostname !== internalServiceHostname) {
      return jsonResponse({ status: "not_found" }, 404);
    }
    let payload: unknown;
    try {
      payload = await context.req.json();
    } catch {
      return jsonResponse({ status: "bad_request", reason: "invalid_json" }, 400);
    }
    try {
      return jsonResponse(await executeNotionWorkflowStep(context.env, payload), 200);
    } catch (error) {
      return jsonResponse({ status: "workflow_step_error", reason: String(error) }, 500);
    }
  });
  app.post("/reindex-jobs", async (context) => {
    if (!(await isAuthorizedIndexRequest(context.req.raw, context.env))) {
      return jsonResponse({ status: "unauthorized" }, 401);
    }
    if (!context.env.NOTION_REINDEX_WORKFLOW) {
      return jsonResponse({ status: "not_configured", reason: "workflow_missing" }, 503);
    }
    let payload: unknown;
    try {
      payload = await context.req.json();
    } catch {
      return jsonResponse({ status: "bad_request", reason: "invalid_json" }, 400);
    }
    if (!isNotionReindexWorkflowPayload(payload)) {
      return jsonResponse({ status: "bad_request", reason: "invalid_payload" }, 400);
    }
    try {
      const instance = await context.env.NOTION_REINDEX_WORKFLOW.create({
        id: payload.jobId,
        params: payload,
      });
      return jsonResponse({ workflowInstanceId: instance.id, jobId: payload.jobId }, 200);
    } catch {
      return jsonResponse({ status: "workflow_error", reason: "workflow_create_failed" }, 503);
    }
  });
  app.get("/reindex-jobs/:jobId", async (context) => {
    if (!(await isAuthorizedIndexRequest(context.req.raw, context.env))) {
      return jsonResponse({ status: "unauthorized" }, 401);
    }
    if (!context.env.NOTION_REINDEX_WORKFLOW) {
      return jsonResponse({ status: "not_configured", reason: "workflow_missing" }, 503);
    }
    try {
      const instance = await context.env.NOTION_REINDEX_WORKFLOW.get(context.req.param("jobId"));
      return jsonResponse({ workflowInstanceId: instance.id, status: await instance.status() });
    } catch {
      return jsonResponse({ status: "workflow_error", reason: "workflow_status_failed" }, 503);
    }
  });
  app.notFound(() => jsonResponse({ status: "not_found" }, 404));
  return app;
}

export class NotionReindexWorkflow extends WorkflowEntrypoint<
  NotionRagMcpBindings,
  NotionReindexWorkflowPayload
> {
  async run(event: WorkflowEvent<NotionReindexWorkflowPayload>, step: WorkflowStep) {
    if (event.payload.mode === "audit") {
      return await step.do("audit notion source index", async () =>
        auditNotionSourceIndex({ env: this.env, payload: event.payload }),
      );
    }
    if (event.payload.mode === "repair") {
      return await repairNotionSourceVectors(this.env, event.payload.sourceId, step);
    }
    return await runNotionReindexWorkflow({ env: this.env, payload: event.payload, step });
  }
}

export class NotionIndexWorkItemWorkflow extends WorkflowEntrypoint<
  NotionRagMcpBindings,
  NotionIndexWorkItemWorkflowPayload
> {
  async run(event: WorkflowEvent<NotionIndexWorkItemWorkflowPayload>, step: WorkflowStep) {
    const delaySeconds = Math.max(0, Math.floor(event.payload.startDelaySeconds ?? 0));
    if (delaySeconds > 0) {
      await step.sleep("stagger notion index work item", `${delaySeconds} seconds`);
    }
    return await step.do(
      "process notion index work item",
      {
        retries: {
          limit: 5,
          delay: "5 seconds",
          backoff: "exponential",
        },
      },
      async () => runNotionIndexWorkItemWorkflow({ env: this.env, payload: event.payload }),
    );
  }
}

async function isAuthorizedIndexRequest(request: Request, env: NotionRagMcpBindings) {
  if (new URL(request.url).hostname === internalServiceHostname) {
    return true;
  }
  return await isAuthorizedRequest(request, env);
}

async function requirePublicAuthorization(request: Request, env: NotionRagMcpBindings) {
  if (!env.MCP_SHARED_SECRET) {
    return jsonResponse({ status: "not_configured", reason: "mcp_shared_secret_missing" }, 503);
  }
  return (await isAuthorizedRequest(request, env))
    ? null
    : jsonResponse({ status: "unauthorized" }, 401);
}

function isNotionReindexWorkflowPayload(value: unknown): value is NotionReindexWorkflowPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    isNonEmptyString(payload.jobId) &&
    isNonEmptyString(payload.sourceId) &&
    isNonEmptyString(payload.actorUserId) &&
    isNonEmptyString(payload.orgId) &&
    (payload.mode === undefined ||
      payload.mode === "reindex" ||
      payload.mode === "audit" ||
      payload.mode === "repair" ||
      payload.mode === "scheduled-reindex")
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
