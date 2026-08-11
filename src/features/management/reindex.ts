import type { NotionRagMcpBindings, NotionReindexWorkflowPayload } from "../../worker/bindings";
import { requireNotionRagDb } from "../indexing/storage";

type SourceRow = { readonly id: string; readonly org_id: string };
type JobRow = {
  readonly job_id: string;
  readonly source_id: string;
  readonly status: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly error_message: string | null;
};

export async function startNotionReindex(env: NotionRagMcpBindings, sourceId: string) {
  if (!env.NOTION_REINDEX_WORKFLOW) {
    throw new Error("workflow_missing");
  }
  const db = requireNotionRagDb(env);
  const source = await db
    .prepare("SELECT id, org_id FROM notion_sources WHERE id = ? AND is_enabled = 1")
    .bind(sourceId)
    .first<SourceRow>();
  if (!source) {
    throw new Error("notion_source_not_found");
  }
  const jobId = `notion-reindex-${source.id}-${Date.now()}`;
  const now = new Date().toISOString();
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO notion_index_jobs
         (job_id, source_id, status, started_by_user_id, started_at, finished_at, error_message)
       VALUES (?, ?, 'queued', 'mcp', ?, NULL, NULL)`,
    )
    .bind(jobId, source.id, now)
    .run();
  if (changedRowCount(inserted) !== 1) {
    const active = await db
      .prepare(
        `SELECT job_id, source_id, status, started_at, finished_at, error_message
           FROM notion_index_jobs
          WHERE source_id = ? AND status IN ('queued', 'running')
          ORDER BY started_at ASC LIMIT 1`,
      )
      .bind(source.id)
      .first<JobRow>();
    if (!active) {
      throw new Error("notion_reindex_job_conflict");
    }
    return { jobId: active.job_id, sourceId: active.source_id, status: active.status, alreadyRunning: true };
  }
  const payload: NotionReindexWorkflowPayload = {
    jobId,
    sourceId: source.id,
    actorUserId: "mcp",
    orgId: source.org_id,
  };
  try {
    const instance = await env.NOTION_REINDEX_WORKFLOW.create({ id: jobId, params: payload });
    return { jobId, sourceId: source.id, status: "queued", workflowInstanceId: instance.id };
  } catch (error) {
    await db
      .prepare(
        `UPDATE notion_index_jobs SET status = 'failed', finished_at = ?, error_message = ?
          WHERE job_id = ?`,
      )
      .bind(new Date().toISOString(), String(error).slice(0, 1000), jobId)
      .run();
    throw error;
  }
}

export async function getNotionReindexStatus(env: NotionRagMcpBindings, jobId: string) {
  const job = await requireNotionRagDb(env)
    .prepare(
      `SELECT job_id, source_id, status, started_at, finished_at, error_message
         FROM notion_index_jobs WHERE job_id = ?`,
    )
    .bind(jobId)
    .first<JobRow>();
  if (!job) {
    return null;
  }
  let workflowStatus: unknown;
  if (env.NOTION_REINDEX_WORKFLOW) {
    try {
      workflowStatus = await (await env.NOTION_REINDEX_WORKFLOW.get(jobId)).status();
    } catch {
      workflowStatus = { unavailable: true };
    }
  }
  return {
    jobId: job.job_id,
    sourceId: job.source_id,
    status: job.status,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    errorMessage: job.error_message,
    ...(workflowStatus === undefined ? {} : { workflowStatus }),
  };
}

function changedRowCount(result: unknown) {
  if (!result || typeof result !== "object") {
    return 1;
  }
  const changes = (result as { readonly meta?: { readonly changes?: unknown } }).meta?.changes;
  return typeof changes === "number" ? changes : 1;
}
