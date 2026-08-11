import type { NotionRagMcpBindings } from "../../worker/bindings";
import { embedTexts, requireNotionRagDb, requireVectorize } from "../indexing/storage";
import type { NotionChunkRow, NotionPageRow } from "./types";
import {
  calculateKeywordBoost,
  createD1LikePattern,
  createFtsMatchQuery,
  extractKeywordTerms,
  isFtsSearchUnavailableError,
  mapNotionSearchRow,
  mergeSearchResults,
  rerankSearchResults,
  selectConfidentSearchResults,
  selectPageGroupedSearchResults,
} from "./search";

export async function searchIndexedNotion(input: {
  readonly env: NotionRagMcpBindings;
  readonly query: string;
  readonly limit?: number;
}) {
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const candidateLimit = Math.min(limit * 4, 50);
  const db = requireNotionRagDb(input.env);
  const [vectorSearch, ftsRows, keywordRows] = await Promise.all([
    searchByVector({ env: input.env, db, query: input.query, candidateLimit, timings }),
    measure(timings, "fts", () => searchByFts(db, input.query, candidateLimit)),
    measure(timings, "keyword", () => searchByKeyword(db, input.query, candidateLimit)).catch(
      (error) => {
        console.warn(JSON.stringify({ event: "notion_search_keyword_degraded", error: String(error) }));
        return [] as (NotionChunkRow & NotionPageRow)[];
      },
    ),
  ]);

  const merged = mergeSearchResults([
    ...vectorSearch.rows.map((row) =>
      mapNotionSearchRow(row, { score: vectorSearch.scoreByChunkId.get(row.chunk_id) ?? 0 }),
    ),
    ...ftsRows.map((row) =>
      mapNotionSearchRow(row, {
        score: vectorSearch.scoreByChunkId.get(row.chunk_id) ?? 0,
        keywordBoost: calculateKeywordBoost(row, input.query) + 0.15,
      }),
    ),
    ...keywordRows.map((row) =>
      mapNotionSearchRow(row, {
        score: vectorSearch.scoreByChunkId.get(row.chunk_id) ?? 0,
        keywordBoost: calculateKeywordBoost(row, input.query),
      }),
    ),
  ]);
  const reranked = rerankSearchResults(merged, input.query);
  const results = selectPageGroupedSearchResults(selectConfidentSearchResults(reranked), limit);
  console.info(
    JSON.stringify({
      event: "notion_search_performance",
      durationMs: { ...timings, total: Date.now() - startedAt },
      counts: {
        vectorMatches: vectorSearch.matchCount,
        vectorRows: vectorSearch.rows.length,
        ftsRows: ftsRows.length,
        keywordRows: keywordRows.length,
        returnedPages: results.length,
      },
    }),
  );
  return { results };
}

async function searchByVector(input: {
  readonly env: NotionRagMcpBindings;
  readonly db: ReturnType<typeof requireNotionRagDb>;
  readonly query: string;
  readonly candidateLimit: number;
  readonly timings: Record<string, number>;
}) {
  try {
    const embedding = await measure(input.timings, "embedding", async () => {
      const result = await embedTexts(input.env, [input.query]);
      const vector = result[0];
      if (!vector) {
        throw new Error("workers_ai_embedding_invalid");
      }
      return vector;
    });
    const matches = await measure(input.timings, "vectorize", async () =>
      (await requireVectorize(input.env).query(embedding, {
        topK: input.candidateLimit,
        returnMetadata: "all",
      })).matches,
    );
    const rows = await measure(input.timings, "d1VectorRows", () =>
      getChunksByIds(input.db, matches.map((match) => match.id)),
    );
    return {
      matchCount: matches.length,
      rows,
      scoreByChunkId: new Map(matches.map((match) => [match.id, match.score])),
    };
  } catch (error) {
    console.warn(JSON.stringify({ event: "notion_search_vector_degraded", error: String(error) }));
    return {
      matchCount: 0,
      rows: [] as (NotionChunkRow & NotionPageRow)[],
      scoreByChunkId: new Map<string, number>(),
    };
  }
}

async function getChunksByIds(
  db: ReturnType<typeof requireNotionRagDb>,
  chunkIds: readonly string[],
) {
  const ids = [...new Set(chunkIds)];
  if (ids.length === 0) {
    return [];
  }
  const rows = await db
    .prepare(
      `SELECT c.chunk_id, c.page_id, c.source_id, c.chunk_index, c.text,
              p.title, p.url, p.last_edited_time, p.indexed_at
         FROM notion_chunks c
         JOIN notion_pages p ON p.page_id = c.page_id AND p.source_id = c.source_id
        WHERE c.chunk_id IN (${ids.map(() => "?").join(", ")}) AND p.is_deleted = 0`,
    )
    .bind(...ids)
    .all<NotionChunkRow & NotionPageRow>();
  const byId = new Map(rows.results.map((row) => [row.chunk_id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

async function searchByFts(
  db: ReturnType<typeof requireNotionRagDb>,
  query: string,
  limit: number,
) {
  const match = createFtsMatchQuery(query);
  if (!match) {
    return [];
  }
  try {
    const rows = await db
      .prepare(
        `SELECT c.chunk_id, c.page_id, c.source_id, c.chunk_index, c.text,
                p.title, p.url, p.last_edited_time, p.indexed_at
           FROM notion_chunks_fts
           JOIN notion_chunks c ON c.chunk_id = notion_chunks_fts.chunk_id
           JOIN notion_pages p ON p.page_id = notion_chunks_fts.page_id
                              AND p.source_id = notion_chunks_fts.source_id
          WHERE p.is_deleted = 0 AND notion_chunks_fts MATCH ?
          ORDER BY rank LIMIT ?`,
      )
      .bind(match, limit)
      .all<NotionChunkRow & NotionPageRow>();
    return rows.results;
  } catch (error) {
    if (isFtsSearchUnavailableError(error)) {
      return [];
    }
    throw error;
  }
}

async function searchByKeyword(
  db: ReturnType<typeof requireNotionRagDb>,
  query: string,
  limit: number,
) {
  const patterns = extractKeywordTerms(query)
    .map(createD1LikePattern)
    .filter((value): value is string => value !== null)
    .slice(0, 4);
  if (patterns.length === 0) {
    return [];
  }
  const clauses = patterns.map(() => "(p.title LIKE ? ESCAPE '\\' OR c.text LIKE ? ESCAPE '\\')");
  const values = patterns.flatMap((pattern) => [pattern, pattern]);
  const rows = await db
    .prepare(
      `SELECT c.chunk_id, c.page_id, c.source_id, c.chunk_index, c.text,
              p.title, p.url, p.last_edited_time, p.indexed_at
         FROM notion_chunks c
         JOIN notion_pages p ON p.page_id = c.page_id AND p.source_id = c.source_id
        WHERE p.is_deleted = 0 AND (${clauses.join(" OR ")})
        ORDER BY CASE WHEN p.title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
                 c.indexed_at DESC LIMIT ?`,
    )
    .bind(...values, patterns[0], limit)
    .all<NotionChunkRow & NotionPageRow>();
  return rows.results;
}

async function measure<T>(
  timings: Record<string, number>,
  name: string,
  operation: () => Promise<T>,
) {
  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    timings[name] = Date.now() - startedAt;
  }
}
