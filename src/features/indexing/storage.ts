import type {
  CloudflareD1Database,
  NotionRagMcpBindings,
  VectorizeVector,
} from "../../worker/bindings";
import { readUnknownRecord, sha256Hex } from "../notion/content";

const defaultEmbeddingModel = "@cf/baai/bge-m3";
const defaultVectorizeDimensions = 1024;
const defaultMonthlyVectorizeUpsertDimensionWarning = 20_000_000;
const defaultMonthlyVectorizeUpsertDimensionBudget = 24_000_000;
const maxEmbeddingBatchSize = 50;
const maxVectorizeUpsertBatchSize = 50;

export class VectorizeUpsertBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorizeUpsertBudgetError";
  }
}

export async function upsertVectors(
  env: NotionRagMcpBindings,
  vectors: readonly VectorizeVector[],
) {
  const vectorize = requireVectorize(env);
  for (let index = 0; index < vectors.length; index += maxVectorizeUpsertBatchSize) {
    await vectorize.upsert(vectors.slice(index, index + maxVectorizeUpsertBatchSize));
  }
}

export async function upsertStoredPageVectors(
  env: NotionRagMcpBindings,
  sourceId: string,
  pageId: string,
) {
  const rows = await requireNotionRagDb(env)
    .prepare(
      `SELECT chunk_id, chunk_index, text
         FROM notion_chunks
        WHERE source_id = ? AND page_id = ?
        ORDER BY chunk_index ASC`,
    )
    .bind(sourceId, pageId)
    .all<{ readonly chunk_id: string; readonly chunk_index: number; readonly text: string }>();
  if (rows.results.length === 0) {
    return { vectorCount: 0 };
  }
  await reserveVectorizeUpsertBudget(env, rows.results.length);
  const embeddings = await embedTexts(
    env,
    rows.results.map((row) => row.text),
  );
  await upsertVectors(
    env,
    rows.results.map((row, index) => {
      const values = embeddings[index];
      if (!values) {
        throw new Error("workers_ai_embedding_invalid");
      }
      return {
        id: row.chunk_id,
        values,
        metadata: { source_id: sourceId, page_id: pageId, chunk_index: row.chunk_index },
      };
    }),
  );
  return { vectorCount: rows.results.length };
}

export async function reserveVectorizeUpsertBudget(
  env: NotionRagMcpBindings,
  vectorCount: number,
  now = new Date(),
) {
  if (!Number.isSafeInteger(vectorCount) || vectorCount < 0) {
    throw new VectorizeUpsertBudgetError("vectorize_vector_count_invalid");
  }
  if (vectorCount === 0) {
    return { usageMonth: toUsageMonth(now), reservedDimensions: 0, usedDimensions: 0 };
  }

  const dimensions = readPositiveInteger(
    env.NOTION_VECTORIZE_DIMENSIONS,
    defaultVectorizeDimensions,
    "vectorize_dimensions_invalid",
  );
  const budget = readPositiveInteger(
    env.NOTION_VECTORIZE_MONTHLY_UPSERT_DIMENSION_BUDGET,
    defaultMonthlyVectorizeUpsertDimensionBudget,
    "vectorize_monthly_upsert_budget_invalid",
  );
  const warningThreshold = readPositiveInteger(
    env.NOTION_VECTORIZE_MONTHLY_UPSERT_DIMENSION_WARNING,
    defaultMonthlyVectorizeUpsertDimensionWarning,
    "vectorize_monthly_upsert_warning_invalid",
  );
  if (warningThreshold > budget) {
    throw new VectorizeUpsertBudgetError("vectorize_monthly_upsert_warning_invalid");
  }
  const requestedDimensions = vectorCount * dimensions;
  if (!Number.isSafeInteger(requestedDimensions) || requestedDimensions > budget) {
    throw new VectorizeUpsertBudgetError(
      `vectorize_monthly_upsert_budget_exceeded:${toUsageMonth(now)}:${requestedDimensions}:${budget}`,
    );
  }

  const usageMonth = toUsageMonth(now);
  const updatedAt = now.toISOString();
  const reservation = await requireNotionRagDb(env)
    .prepare(
      `INSERT INTO notion_vectorize_monthly_usage
        (usage_month, upserted_dimensions, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(usage_month) DO UPDATE SET
         upserted_dimensions = notion_vectorize_monthly_usage.upserted_dimensions + excluded.upserted_dimensions,
         updated_at = excluded.updated_at
       WHERE notion_vectorize_monthly_usage.upserted_dimensions + excluded.upserted_dimensions <= ?
       RETURNING upserted_dimensions`,
    )
    .bind(usageMonth, requestedDimensions, updatedAt, budget)
    .first<{ readonly upserted_dimensions: number }>();
  if (!reservation) {
    throw new VectorizeUpsertBudgetError(
      `vectorize_monthly_upsert_budget_exceeded:${usageMonth}:${requestedDimensions}:${budget}`,
    );
  }
  if (
    reservation.upserted_dimensions - requestedDimensions < warningThreshold &&
    reservation.upserted_dimensions >= warningThreshold
  ) {
    console.warn(
      JSON.stringify({
        event: "vectorize_monthly_upsert_budget_warning",
        usageMonth,
        usedDimensions: reservation.upserted_dimensions,
        warningThreshold,
        budget,
      }),
    );
  }
  return {
    usageMonth,
    reservedDimensions: requestedDimensions,
    usedDimensions: reservation.upserted_dimensions,
  };
}

export async function clearSourceIndex(env: NotionRagMcpBindings, sourceId: string) {
  const db = requireNotionRagDb(env);
  const oldChunks = await db
    .prepare("SELECT chunk_id FROM notion_chunks WHERE source_id = ?")
    .bind(sourceId)
    .all<{ chunk_id: string }>();
  await db.prepare("DELETE FROM notion_chunks WHERE source_id = ?").bind(sourceId).run();
  await deleteSourceFtsRows(db, sourceId);
  await db
    .prepare("UPDATE notion_pages SET is_deleted = 1 WHERE source_id = ?")
    .bind(sourceId)
    .run();
  return oldChunks.results.map((row) => row.chunk_id);
}

export async function getSourceChunkIds(env: NotionRagMcpBindings, sourceId: string) {
  const rows = await requireNotionRagDb(env)
    .prepare("SELECT chunk_id FROM notion_chunks WHERE source_id = ?")
    .bind(sourceId)
    .all<{ chunk_id: string }>();
  return rows.results.map((row) => row.chunk_id);
}

export async function clearPageChunks(db: CloudflareD1Database, sourceId: string, pageId: string) {
  await db
    .prepare("DELETE FROM notion_chunks WHERE source_id = ? AND page_id = ?")
    .bind(sourceId, pageId)
    .run();
  await deletePageFtsRows(db, sourceId, pageId);
}

export async function insertNotionChunkFts(input: {
  readonly db: CloudflareD1Database;
  readonly chunkId: string;
  readonly pageId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly text: string;
}) {
  try {
    await input.db
      .prepare(
        `INSERT INTO notion_chunks_fts
          (chunk_id, page_id, source_id, title, text)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(input.chunkId, input.pageId, input.sourceId, input.title, input.text)
      .run();
  } catch (error) {
    if (!isMissingFtsTableError(error)) {
      throw error;
    }
  }
}

async function deleteSourceFtsRows(db: CloudflareD1Database, sourceId: string) {
  try {
    await db.prepare("DELETE FROM notion_chunks_fts WHERE source_id = ?").bind(sourceId).run();
  } catch (error) {
    if (!isMissingFtsTableError(error)) {
      throw error;
    }
  }
}

async function deletePageFtsRows(db: CloudflareD1Database, sourceId: string, pageId: string) {
  try {
    await db
      .prepare("DELETE FROM notion_chunks_fts WHERE source_id = ? AND page_id = ?")
      .bind(sourceId, pageId)
      .run();
  } catch (error) {
    if (!isMissingFtsTableError(error)) {
      throw error;
    }
  }
}

export function isMissingFtsTableError(error: unknown) {
  const message = String(error).toLowerCase();
  return message.includes("notion_chunks_fts") && message.includes("no such table");
}

export async function deleteStaleVectors(
  env: NotionRagMcpBindings,
  chunkIds: readonly string[],
) {
  const vectorize = requireVectorize(env);
  for (let index = 0; index < chunkIds.length; index += 100) {
    const ids = chunkIds.slice(index, index + 100);
    if (ids.length > 0) {
      await vectorize.deleteByIds(ids);
    }
  }
}

export async function createNotionChunkId(sourceId: string, pageId: string, chunkIndex: number) {
  const hash = await sha256Hex(`${sourceId}:${pageId}:${chunkIndex}`);
  return `n:${hash.slice(0, 32)}`;
}

export async function embedTexts(
  env: NotionRagMcpBindings,
  texts: readonly string[],
): Promise<readonly (readonly number[])[]> {
  if (!env.AI) {
    throw new Error("workers_ai_not_configured");
  }
  const embeddings: number[][] = [];
  for (let index = 0; index < texts.length; index += maxEmbeddingBatchSize) {
    const batch = texts.slice(index, index + maxEmbeddingBatchSize);
    const response = await env.AI.run(getNotionEmbeddingModel(env), {
      text: batch,
    });
    const data = readUnknownRecord(response)?.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new Error("workers_ai_embedding_invalid");
    }
    for (const embedding of data) {
      if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === "number")) {
        throw new Error("workers_ai_embedding_invalid");
      }
      embeddings.push(embedding);
    }
  }
  return embeddings;
}

export function getNotionEmbeddingModel(env: NotionRagMcpBindings) {
  return env.NOTION_EMBEDDING_MODEL ?? defaultEmbeddingModel;
}

function readPositiveInteger(rawValue: string | undefined, fallback: number, errorCode: string) {
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VectorizeUpsertBudgetError(errorCode);
  }
  return value;
}

function toUsageMonth(date: Date) {
  const iso = date.toISOString();
  return iso.slice(0, 7);
}

export function requireNotionRagDb(env: NotionRagMcpBindings) {
  if (!env.NOTION_RAG_DB) {
    throw new Error("notion_rag_db_not_configured");
  }
  return env.NOTION_RAG_DB;
}

export function requireVectorize(env: NotionRagMcpBindings) {
  if (!env.NOTION_VECTORIZE) {
    throw new Error("notion_vectorize_not_configured");
  }
  return env.NOTION_VECTORIZE;
}

export async function updateIndexJob(
  env: NotionRagMcpBindings,
  jobId: string,
  status: string,
  errorMessage: string | null = null,
) {
  await requireNotionRagDb(env)
    .prepare(
      `UPDATE notion_index_jobs
          SET status = ?, finished_at = CASE WHEN ? IN ('succeeded', 'failed') THEN ? ELSE finished_at END,
              error_message = ?
        WHERE job_id = ?`,
    )
    .bind(status, status, new Date().toISOString(), errorMessage, jobId)
    .run();
}
