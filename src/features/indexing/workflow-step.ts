import type { NotionRagMcpBindings } from "../../worker/bindings";
import { indexExternalLinks } from "./external-documents";
import { maxExternalLinksPerStep } from "./config";
import { MAX_INDEXED_PAGES } from "./limits";
import { discoverNotionDatabaseForWorkflow, discoverNotionPageForWorkflow } from "./page-discovery";
import { indexNotionPage } from "./page-persistence";
import type { NotionWorkflowStepRequest } from "./workflow-types";

export async function executeNotionWorkflowStep(
  env: NotionRagMcpBindings,
  rawRequest: unknown,
) {
  const request = parseNotionWorkflowStepRequest(rawRequest);
  switch (request.type) {
    case "discover-page":
      return await discoverNotionPageForWorkflow(env, request.pageId);
    case "discover-database":
      return await discoverNotionDatabaseForWorkflow(env, request.databaseId, request.limit);
    case "index-page":
      return await indexNotionPage(
        env,
        request.sourceId,
        { pageId: request.pageId },
        request.indexedAt,
      );
    case "index-external-links":
      return await indexExternalLinks({
        env,
        sourceId: request.sourceId,
        links: request.links,
        indexedAt: request.indexedAt,
      });
  }
}

export async function runNotionWorkflowStep<T>(
  env: NotionRagMcpBindings,
  request: NotionWorkflowStepRequest,
): Promise<T> {
  if (!env.NOTION_INDEX_SERVICE) {
    return (await executeNotionWorkflowStep(env, request)) as T;
  }
  const response = await env.NOTION_INDEX_SERVICE.fetch(
    new Request("https://notion-rag-mcp.internal/internal/workflow-step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const reason =
      body && typeof body === "object" && "reason" in body
        ? String((body as { readonly reason?: unknown }).reason)
        : `status_${response.status}`;
    throw new Error(`notion_workflow_step_failed:${request.type}:${reason}`);
  }
  return body as T;
}

function parseNotionWorkflowStepRequest(raw: unknown): NotionWorkflowStepRequest {
  if (!raw || typeof raw !== "object") {
    throw new Error("notion_workflow_step_invalid");
  }
  const request = raw as Record<string, unknown>;
  if (request.type === "discover-page" && isNonEmptyString(request.pageId)) {
    return { type: request.type, pageId: request.pageId };
  }
  if (
    request.type === "discover-database" &&
    isNonEmptyString(request.databaseId) &&
    Number.isSafeInteger(request.limit) &&
    Number(request.limit) >= 0 &&
    Number(request.limit) <= MAX_INDEXED_PAGES
  ) {
    return { type: request.type, databaseId: request.databaseId, limit: Number(request.limit) };
  }
  if (
    request.type === "index-page" &&
    isNonEmptyString(request.sourceId) &&
    isNonEmptyString(request.pageId) &&
    isNonEmptyString(request.indexedAt)
  ) {
    return {
      type: request.type,
      sourceId: request.sourceId,
      pageId: request.pageId,
      indexedAt: request.indexedAt,
    };
  }
  if (
    request.type === "index-external-links" &&
    isNonEmptyString(request.sourceId) &&
    isNonEmptyString(request.indexedAt) &&
    Array.isArray(request.links) &&
    request.links.length <= maxExternalLinksPerStep
  ) {
    const links = request.links.flatMap((link) => {
      if (!link || typeof link !== "object") return [];
      const item = link as Record<string, unknown>;
      return isNonEmptyString(item.parentPageId) && isNonEmptyString(item.url)
        ? [{ parentPageId: item.parentPageId, url: item.url }]
        : [];
    });
    if (links.length === request.links.length) {
      return {
        type: request.type,
        sourceId: request.sourceId,
        links,
        indexedAt: request.indexedAt,
      };
    }
  }
  throw new Error("notion_workflow_step_invalid");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
