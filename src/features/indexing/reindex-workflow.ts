import type {
  NotionRagMcpBindings,
  NotionReindexWorkflowPayload,
} from "../../worker/bindings";
import { isPermanentNotionAccessError } from "../notion/client";
import { indexNotionSource } from "./source-index";
import { requireNotionRagDb, updateIndexJob } from "./storage";
import {
  immediateWorkflowStep,
  type NotionSourceRow,
  type ReindexWorkflowStep,
} from "./workflow-types";

export async function runNotionReindexWorkflow(input: {
  readonly env: NotionRagMcpBindings;
  readonly payload: NotionReindexWorkflowPayload;
  readonly step?: ReindexWorkflowStep;
}) {
  const db = requireNotionRagDb(input.env);
  const step = input.step ?? immediateWorkflowStep;
  try {
    await claimNotionIndexJob(input.env, input.payload);
    const source = await db
      .prepare("SELECT * FROM notion_sources WHERE id = ? AND is_enabled = 1")
      .bind(input.payload.sourceId)
      .first<NotionSourceRow>();
    if (!source) {
      throw new Error("notion_source_not_found");
    }
    const indexed = await indexNotionSource(input.env, source, step, input.payload.jobId);
    await updateIndexJob(input.env, input.payload.jobId, "succeeded");
    return {
      indexedPageCount: indexed.pageCount,
      indexedChunkCount: indexed.chunkCount,
      indexedExternalLinkCount: indexed.externalLinkCount,
    };
  } catch (error) {
    await updateIndexJob(input.env, input.payload.jobId, "failed", String(error));
    if (isPermanentNotionAccessError(error)) {
      return {
        error: String(error),
        indexedChunkCount: 0,
        indexedPageCount: 0,
      };
    }
    throw error;
  }
}

export async function startScheduledNotionReindexes(env: NotionRagMcpBindings) {
  if (!env.NOTION_REINDEX_WORKFLOW) {
    throw new Error("workflow_missing");
  }
  const db = requireNotionRagDb(env);
  const now = new Date().toISOString();
  const rows = await db
    .prepare("SELECT * FROM notion_sources WHERE is_enabled = 1 ORDER BY id ASC")
    .all<NotionSourceRow>();
  const created: { readonly jobId: string; readonly sourceId: string }[] = [];
  for (const source of rows.results) {
    const jobId = `notion-scheduled-${source.id}-${Date.now()}`;
    const payload: NotionReindexWorkflowPayload = {
      jobId,
      sourceId: source.id,
      actorUserId: "scheduled",
      orgId: source.org_id,
      mode: "scheduled-reindex",
    };
    const insertResult = await db
      .prepare(
        `INSERT OR IGNORE INTO notion_index_jobs
          (job_id, source_id, status, started_by_user_id, started_at, finished_at, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(jobId, source.id, "queued", "scheduled", now, null, null)
      .run();
    if (getChangedRowCount(insertResult) !== 1) {
      continue;
    }
    try {
      await env.NOTION_REINDEX_WORKFLOW.create({ id: jobId, params: payload });
    } catch (error) {
      await updateIndexJob(env, jobId, "failed", String(error));
      throw error;
    }
    created.push({ jobId, sourceId: source.id });
  }
  return { createdJobCount: created.length, jobs: created };
}

async function claimNotionIndexJob(
  env: NotionRagMcpBindings,
  payload: NotionReindexWorkflowPayload,
) {
  const db = requireNotionRagDb(env);
  const now = new Date().toISOString();
  const resumeResult = await db
    .prepare(
      `UPDATE notion_index_jobs
          SET status = 'running', finished_at = NULL, error_message = NULL
        WHERE job_id = ? AND source_id = ? AND status IN ('queued', 'running')`,
    )
    .bind(payload.jobId, payload.sourceId)
    .run();
  if (getChangedRowCount(resumeResult) === 1) {
    return;
  }
  const insertResult = await db
    .prepare(
      `INSERT OR IGNORE INTO notion_index_jobs
        (job_id, source_id, status, started_by_user_id, started_at, finished_at, error_message)
       VALUES (?, ?, 'queued', ?, ?, NULL, NULL)`,
    )
    .bind(payload.jobId, payload.sourceId, payload.actorUserId, now)
    .run();
  if (getChangedRowCount(insertResult) === 1) {
    await updateIndexJob(env, payload.jobId, "running");
    return;
  }
  const activeJob = await db
    .prepare(
      `SELECT job_id FROM notion_index_jobs
       WHERE source_id = ? AND status IN ('queued', 'running')
       ORDER BY started_at ASC
       LIMIT 1`,
    )
    .bind(payload.sourceId)
    .first<{ readonly job_id: string }>();
  if (activeJob?.job_id !== payload.jobId) {
    throw new Error(`notion_source_reindex_in_progress:${activeJob?.job_id ?? "unknown"}`);
  }
  await updateIndexJob(env, payload.jobId, "running");
}

function getChangedRowCount(result: unknown) {
  if (!result || typeof result !== "object") {
    return 1;
  }
  const meta = (result as { readonly meta?: unknown }).meta;
  if (!meta || typeof meta !== "object") {
    return 1;
  }
  const changes = (meta as { readonly changes?: unknown }).changes;
  return typeof changes === "number" ? changes : 1;
}
