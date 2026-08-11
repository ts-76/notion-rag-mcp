import type {
  NotionRagMcpBindings,
  NotionIndexWorkItemWorkflowPayload,
} from "../../worker/bindings";
import { createIndexingNotionClient, isNotionInaccessibleDatabaseError } from "../notion/client";
import {
  isNotionPageExcludedFromSearch,
  normalizeNotionId,
  type NotionBlock,
  type NotionPage,
} from "../notion/content";
import { maxBlocksPerPage, maxNotionRequestsPerPageWorkItem } from "./config";
import { indexExternalLinks } from "./external-documents";
import { MAX_INDEXED_PAGES } from "./limits";
import { persistNotionPageIndex } from "./page-persistence";
import { requireNotionRagDb } from "./storage";
import type { DatabaseDiscoveryResult, NotionSourceRow, PageIndexResult } from "./workflow-types";

type WorkItemStateRow = {
  readonly status: string;
  readonly result_json: string | null;
  readonly state_json: string | null;
};

type PendingNotionBlockPage = {
  readonly blockId: string;
  readonly cursor?: string;
};

type PageWorkItemState = {
  readonly processedPart: number;
  readonly page: NotionPage;
  readonly blocks: readonly NotionBlock[];
  readonly pending: readonly PendingNotionBlockPage[];
};

export async function runNotionIndexWorkItemWorkflow(input: {
  readonly env: NotionRagMcpBindings;
  readonly payload: NotionIndexWorkItemWorkflowPayload;
}) {
  const db = requireNotionRagDb(input.env);
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE notion_index_work_items
          SET status = 'running', error_message = NULL, updated_at = ?
        WHERE job_id = ? AND item_id = ? AND status <> 'succeeded'`,
    )
    .bind(now, input.payload.jobId, input.payload.itemId)
    .run();
  try {
    const source = await db
      .prepare("SELECT * FROM notion_sources WHERE id = ? AND is_enabled = 1")
      .bind(input.payload.sourceId)
      .first<NotionSourceRow>();
    if (!source) {
      throw new Error("notion_source_not_found");
    }
    const processed =
      input.payload.itemType === "page"
        ? input.payload.databaseId
          ? {
              completed: true as const,
              result: await discoverDatabasePageIds(input.env, input.payload.databaseId),
            }
          : await processNotionPageWorkItem(input.env, source, input.payload)
        : {
            completed: true as const,
            result: await indexExternalLinks({
              env: input.env,
              sourceId: source.id,
              links: input.payload.links ?? [],
              indexedAt: input.payload.indexedAt,
            }),
          };
    if (!processed.completed) {
      return processed;
    }
    const result = processed.result;
    await db
      .prepare(
        `UPDATE notion_index_work_items
            SET status = 'succeeded', result_json = ?, state_json = NULL,
                error_message = NULL, updated_at = ?
          WHERE job_id = ? AND item_id = ?`,
      )
      .bind(
        JSON.stringify(result),
        new Date().toISOString(),
        input.payload.jobId,
        input.payload.itemId,
      )
      .run();
    return result;
  } catch (error) {
    await db
      .prepare(
        `UPDATE notion_index_work_items
            SET status = 'failed', error_message = ?, updated_at = ?
          WHERE job_id = ? AND item_id = ?`,
      )
      .bind(
        String(error).slice(0, 1000),
        new Date().toISOString(),
        input.payload.jobId,
        input.payload.itemId,
      )
      .run();
    throw error;
  }
}

async function discoverDatabasePageIds(
  env: NotionRagMcpBindings,
  databaseId: string,
): Promise<DatabaseDiscoveryResult> {
  const client = createIndexingNotionClient(env);
  try {
    const database = await client.retrieveDatabase(databaseId);
    const pages = await client.queryDatabasePages(database, { limit: MAX_INDEXED_PAGES });
    return {
      kind: "database",
      pageIds: pages.map((page) => normalizeNotionId(page.id)),
    };
  } catch (error) {
    if (!isNotionInaccessibleDatabaseError(error)) {
      throw error;
    }
    return { kind: "database", pageIds: [] };
  }
}

async function processNotionPageWorkItem(
  env: NotionRagMcpBindings,
  source: NotionSourceRow,
  payload: NotionIndexWorkItemWorkflowPayload,
): Promise<
  | { readonly completed: true; readonly result: PageIndexResult }
  | { readonly completed: false; readonly nextPart: number }
> {
  const db = requireNotionRagDb(env);
  const part = payload.part ?? 1;
  const row = await db
    .prepare(
      `SELECT status, result_json, state_json
         FROM notion_index_work_items
        WHERE job_id = ? AND item_id = ?`,
    )
    .bind(payload.jobId, payload.itemId)
    .first<WorkItemStateRow>();
  if (row?.status === "succeeded" && row.result_json) {
    return { completed: true, result: JSON.parse(row.result_json) as PageIndexResult };
  }
  const storedState = row?.state_json
    ? (JSON.parse(row.state_json) as PageWorkItemState)
    : undefined;
  if (storedState && isNotionPageExcludedFromSearch(storedState.page)) {
    const result = await persistNotionPageIndex(
      env,
      source.id,
      storedState.page,
      [],
      payload.indexedAt,
      true,
    );
    return { completed: true, result };
  }
  if (storedState && storedState.processedPart >= part) {
    if (storedState.pending.length === 0 || storedState.blocks.length >= maxBlocksPerPage) {
      const result = await persistNotionPageIndex(
        env,
        source.id,
        storedState.page,
        storedState.blocks,
        payload.indexedAt,
        storedState.pending.length === 0,
      );
      return { completed: true, result };
    }
    await launchPageWorkItemContinuation(env, payload, part + 1);
    return { completed: false, nextPart: part + 1 };
  }

  const client = createIndexingNotionClient(env);
  const page = storedState?.page ?? (await client.retrievePage(requireWorkItemPageId(payload)));
  if (isNotionPageExcludedFromSearch(page)) {
    const result = await persistNotionPageIndex(env, source.id, page, [], payload.indexedAt, true);
    return { completed: true, result };
  }
  const pageId = normalizeNotionId(page.id);
  const blocks = [...(storedState?.blocks ?? [])];
  const pending: PendingNotionBlockPage[] = storedState
    ? [...storedState.pending]
    : [{ blockId: pageId }];
  let requestCount = storedState ? 0 : 1;
  while (
    pending.length > 0 &&
    blocks.length < maxBlocksPerPage &&
    requestCount < maxNotionRequestsPerPageWorkItem
  ) {
    const current = pending.shift();
    if (!current) {
      continue;
    }
    const response = await client.listBlockChildrenPage(current.blockId, current.cursor);
    requestCount += 1;
    const remainingCapacity = maxBlocksPerPage - blocks.length;
    const nextBlocks = response.blocks.slice(0, remainingCapacity);
    blocks.push(...nextBlocks);
    if (response.nextCursor && blocks.length < maxBlocksPerPage) {
      pending.unshift({ blockId: current.blockId, cursor: response.nextCursor });
    }
    pending.push(
      ...nextBlocks
        .filter(
          (block) =>
            block.has_children && block.type !== "child_page" && block.type !== "child_database",
        )
        .map((block) => ({ blockId: block.id })),
    );
  }

  if (pending.length === 0 || blocks.length >= maxBlocksPerPage) {
    const result = await persistNotionPageIndex(
      env,
      source.id,
      page,
      blocks,
      payload.indexedAt,
      pending.length === 0,
    );
    return { completed: true, result };
  }

  const state: PageWorkItemState = {
    processedPart: part,
    page,
    blocks,
    pending,
  };
  await db
    .prepare(
      `UPDATE notion_index_work_items
          SET status = 'running', state_json = ?, updated_at = ?
        WHERE job_id = ? AND item_id = ?`,
    )
    .bind(JSON.stringify(state), new Date().toISOString(), payload.jobId, payload.itemId)
    .run();
  await launchPageWorkItemContinuation(env, payload, part + 1);
  return { completed: false, nextPart: part + 1 };
}

async function launchPageWorkItemContinuation(
  env: NotionRagMcpBindings,
  payload: NotionIndexWorkItemWorkflowPayload,
  nextPart: number,
) {
  const workflow = env.NOTION_INDEX_WORK_ITEM_WORKFLOW;
  if (!workflow) {
    throw new Error("index_work_item_workflow_missing");
  }
  await workflow.createBatch([
    {
      id: `${payload.jobId}-${payload.itemId}-part-${nextPart}`,
      params: { ...payload, part: nextPart, startDelaySeconds: 0 },
    },
  ]);
}

function requireWorkItemPageId(payload: NotionIndexWorkItemWorkflowPayload) {
  if (!payload.pageId) {
    throw new Error("notion_page_work_item_missing_page_id");
  }
  return payload.pageId;
}
