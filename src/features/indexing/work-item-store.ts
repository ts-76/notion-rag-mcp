import type {
  NotionRagMcpBindings,
  NotionIndexWorkItemWorkflowPayload,
} from "../../worker/bindings";
import {
  maxWorkflowCreateBatchSize,
  maxWorkItemInsertBatchSize,
  maxWorkItemPollAttempts,
  maxWorkItemsPerStartWindow,
  workItemPollDuration,
  workItemStartWindowSeconds,
} from "./config";
import { requireNotionRagDb } from "./storage";
import type { ReindexWorkflowStep } from "./workflow-types";

type WorkItemStatusSummary = {
  readonly total_count: number;
  readonly pending_count: number;
  readonly failed_count: number;
  readonly failed_item_id?: string;
  readonly failed_error_message?: string | null;
};

type WorkItemResultRow = {
  readonly item_id: string;
  readonly result_json: string | null;
};

export async function launchIndexWorkItems(
  env: NotionRagMcpBindings,
  jobId: string,
  payloads: readonly NotionIndexWorkItemWorkflowPayload[],
) {
  const workflow = env.NOTION_INDEX_WORK_ITEM_WORKFLOW;
  if (!workflow) {
    throw new Error("index_work_item_workflow_missing");
  }
  const db = requireNotionRagDb(env);
  const now = new Date().toISOString();
  const scheduledPayloads = payloads.map((payload, index) => ({
    ...payload,
    startDelaySeconds:
      payload.startDelaySeconds ??
      Math.floor(index / maxWorkItemsPerStartWindow) * workItemStartWindowSeconds,
  }));
  const statements = scheduledPayloads.map((payload) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO notion_index_work_items
          (job_id, item_id, item_type, source_id, status, payload_json, result_json, error_message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        jobId,
        payload.itemId,
        payload.itemType,
        payload.sourceId,
        "queued",
        JSON.stringify(payload),
        null,
        null,
        now,
        now,
      ),
  );
  for (let index = 0; index < statements.length; index += maxWorkItemInsertBatchSize) {
    await db.batch(statements.slice(index, index + maxWorkItemInsertBatchSize));
  }
  const instances = scheduledPayloads.map((payload) => ({
    id: `${jobId}-${payload.itemId}`,
    params: payload,
  }));
  for (let index = 0; index < instances.length; index += maxWorkflowCreateBatchSize) {
    await workflow.createBatch(instances.slice(index, index + maxWorkflowCreateBatchSize));
  }
}

export async function waitForIndexWorkItems(
  env: NotionRagMcpBindings,
  step: ReindexWorkflowStep,
  jobId: string,
  itemType: NotionIndexWorkItemWorkflowPayload["itemType"],
  stepScope: string = itemType,
) {
  for (let attempt = 1; attempt <= maxWorkItemPollAttempts; attempt += 1) {
    const summary = await step.do(`check notion ${stepScope} workflows ${attempt}`, async () =>
      getIndexWorkItemStatusSummary(env, jobId, itemType),
    );
    if (summary.failed_count > 0) {
      throw new Error(
        `notion_${itemType}_workflow_failed:${summary.failed_item_id ?? "unknown"}:${summary.failed_error_message ?? "unknown"}`,
      );
    }
    if (summary.total_count > 0 && summary.pending_count === 0) {
      return;
    }
    await step.sleep(`wait for notion ${stepScope} workflows ${attempt}`, workItemPollDuration);
  }
  throw new Error(`notion_${itemType}_workflow_timeout`);
}

export async function loadIndexWorkItemResults<T>(
  env: NotionRagMcpBindings,
  jobId: string,
  itemType: NotionIndexWorkItemWorkflowPayload["itemType"],
) {
  const rows = await loadIndexWorkItemResultRows(env, jobId, itemType);
  return rows.map((row) => JSON.parse(row.result_json ?? "null") as T);
}

export async function loadIndexWorkItemResultRows(
  env: NotionRagMcpBindings,
  jobId: string,
  itemType: NotionIndexWorkItemWorkflowPayload["itemType"],
) {
  const rows = await requireNotionRagDb(env)
    .prepare(
      `SELECT item_id, result_json
         FROM notion_index_work_items
        WHERE job_id = ? AND item_type = ? AND status = 'succeeded'
        ORDER BY item_id ASC`,
    )
    .bind(jobId, itemType)
    .all<WorkItemResultRow>();
  return rows.results;
}

async function getIndexWorkItemStatusSummary(
  env: NotionRagMcpBindings,
  jobId: string,
  itemType: NotionIndexWorkItemWorkflowPayload["itemType"],
) {
  const db = requireNotionRagDb(env);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total_count,
              SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS pending_count,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
         FROM notion_index_work_items
        WHERE job_id = ? AND item_type = ?`,
    )
    .bind(jobId, itemType)
    .first<WorkItemStatusSummary>();
  const failed =
    Number(row?.failed_count ?? 0) === 0
      ? null
      : await db
          .prepare(
            `SELECT item_id, error_message
               FROM notion_index_work_items
              WHERE job_id = ? AND item_type = ? AND status = 'failed'
              ORDER BY item_id ASC
              LIMIT 1`,
          )
          .bind(jobId, itemType)
          .first<{ readonly item_id: string; readonly error_message: string | null }>();
  return {
    total_count: Number(row?.total_count ?? 0),
    pending_count: Number(row?.pending_count ?? 0),
    failed_count: Number(row?.failed_count ?? 0),
    ...(failed
      ? { failed_item_id: failed.item_id, failed_error_message: failed.error_message }
      : {}),
  };
}
