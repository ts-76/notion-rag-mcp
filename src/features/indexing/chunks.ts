import type {
  CloudflareD1Database,
  CloudflareD1PreparedStatement,
  NotionRagMcpBindings,
  VectorizeVector,
} from "../../worker/bindings";
import { estimateTokenCount, sha256Hex } from "../notion/content";
import { createNotionChunkId, embedTexts, isMissingFtsTableError } from "./storage";

const maxD1BatchStatements = 50;

export async function insertChunks(input: {
  readonly env: NotionRagMcpBindings;
  readonly db: CloudflareD1Database;
  readonly vectors: VectorizeVector[];
  readonly sourceId: string;
  readonly pageId: string;
  readonly title: string;
  readonly chunks: readonly string[];
  readonly indexedAt: string;
}) {
  const rows = await Promise.all(
    input.chunks.map(async (chunk, index) => ({
      chunk,
      index,
      chunkId: await createNotionChunkId(input.sourceId, input.pageId, index),
      chunkHash: await sha256Hex(chunk),
    })),
  );
  const embeddings = await embedTexts(
    input.env,
    rows.map((row) => row.chunk),
  );
  const chunkStatements = rows.map((row) =>
    input.db
      .prepare(
        `INSERT INTO notion_chunks
          (chunk_id, page_id, source_id, chunk_index, text, content_hash, token_count, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.chunkId,
        input.pageId,
        input.sourceId,
        row.index,
        row.chunk,
        row.chunkHash,
        estimateTokenCount(row.chunk),
        input.indexedAt,
      ),
  );
  await runD1Batches(input.db, chunkStatements);

  const ftsStatements = rows.map((row) =>
    input.db
      .prepare(
        `INSERT INTO notion_chunks_fts
          (chunk_id, page_id, source_id, title, text)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(row.chunkId, input.pageId, input.sourceId, input.title, row.chunk),
  );
  try {
    await runD1Batches(input.db, ftsStatements);
  } catch (error) {
    if (!isMissingFtsTableError(error)) {
      throw error;
    }
  }

  for (const [index, row] of rows.entries()) {
    const values = embeddings[index];
    if (!values) {
      throw new Error("workers_ai_embedding_invalid");
    }
    input.vectors.push({
      id: row.chunkId,
      values,
      metadata: { source_id: input.sourceId, page_id: input.pageId, chunk_index: row.index },
    });
  }
  return { chunkCount: rows.length };
}

async function runD1Batches(
  db: CloudflareD1Database,
  statements: readonly CloudflareD1PreparedStatement[],
) {
  for (let index = 0; index < statements.length; index += maxD1BatchStatements) {
    await db.batch(statements.slice(index, index + maxD1BatchStatements));
  }
}
