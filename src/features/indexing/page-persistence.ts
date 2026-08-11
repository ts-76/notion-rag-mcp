import type { NotionRagMcpBindings, VectorizeVector } from "../../worker/bindings";
import {
  createNotionPageChunks,
  extractChildDatabaseIds,
  extractChildPageIds,
  extractExternalUrlsFromBlocks,
  extractNotionPageTitle,
  extractNotionSearchProperties,
  extractParentPageId,
  isNotionPageExcludedFromSearch,
  normalizeNotionId,
  sha256Hex,
  type NotionBlock,
  type NotionPage,
} from "../notion/content";
import { createIndexingNotionClient } from "../notion/client";
import { insertChunks } from "./chunks";
import { maxBlocksPerPage, maxExternalLinksPerSource } from "./config";
import {
  clearPageChunks,
  deleteStaleVectors,
  getNotionEmbeddingModel,
  requireNotionRagDb,
  reserveVectorizeUpsertBudget,
  upsertVectors,
} from "./storage";
import type { NotionPageIndexResult, PageIndexResult, PageToIndexRef } from "./workflow-types";

type ExistingPageIndexRow = {
  readonly content_hash: string | null;
  readonly embedding_model: string | null;
  readonly is_deleted: number;
};

export async function indexNotionPage(
  env: NotionRagMcpBindings,
  sourceId: string,
  pageRef: PageToIndexRef,
  indexedAt: string,
): Promise<NotionPageIndexResult> {
  const client = createIndexingNotionClient(env);
  try {
    const page = await client.retrievePage(pageRef.pageId);
    const pageId = normalizeNotionId(page.id);
    if (isNotionPageExcludedFromSearch(page)) {
      return await persistNotionPageIndex(env, sourceId, page, [], indexedAt, true);
    }
    const blocks = await client.listPageBlocks(pageId, maxBlocksPerPage);
    return await persistNotionPageIndex(env, sourceId, page, blocks, indexedAt);
  } catch (error) {
    throw new Error(`notion_page_index_failed:${pageRef.pageId}:${String(error)}`);
  }
}

export async function persistNotionPageIndex(
  env: NotionRagMcpBindings,
  sourceId: string,
  page: NotionPage,
  blocks: readonly NotionBlock[],
  indexedAt: string,
  discoveryComplete = blocks.length < maxBlocksPerPage,
): Promise<PageIndexResult> {
  const db = requireNotionRagDb(env);
  const vectors: VectorizeVector[] = [];
  let chunkCount = 0;
  try {
    const pageId = normalizeNotionId(page.id);
    if (isNotionPageExcludedFromSearch(page)) {
      await removeNotionPageFromIndex(env, sourceId, pageId);
      return {
        kind: "page",
        pageCount: 0,
        pageId,
        chunkCount: 0,
        externalUrls: [],
        childPageIds: [],
        databaseIds: [],
        discoveryComplete: true,
      };
    }
    const title = extractNotionPageTitle(page);
    const url = page.url ?? `https://www.notion.so/${pageId.replaceAll("-", "")}`;
    const chunks = createNotionPageChunks(title, blocks, extractNotionSearchProperties(page));
    const contentHash = await sha256Hex(chunks.join("\n\n"));
    const embeddingModel = getNotionEmbeddingModel(env);
    const existingPage = await db
      .prepare(
        "SELECT content_hash, embedding_model, is_deleted FROM notion_pages WHERE source_id = ? AND page_id = ?",
      )
      .bind(sourceId, pageId)
      .first<ExistingPageIndexRow>();

    if (
      existingPage?.is_deleted === 0 &&
      existingPage?.content_hash === contentHash &&
      existingPage.embedding_model === embeddingModel
    ) {
      await db
        .prepare(
          `UPDATE notion_pages
              SET title = ?, url = ?, parent_page_id = ?, last_edited_time = ?,
                  last_seen_at = ?, indexed_at = ?, is_deleted = 0
            WHERE page_id = ? AND source_id = ?`,
        )
        .bind(
          title,
          url,
          extractParentPageId(page),
          page.last_edited_time ?? null,
          indexedAt,
          indexedAt,
          pageId,
          sourceId,
        )
        .run();
    } else {
      await reserveVectorizeUpsertBudget(env, chunks.length);
      const oldChunkIds = await getPageChunkIds(db, sourceId, pageId);
      await db
        .prepare("UPDATE notion_pages SET is_deleted = 1 WHERE source_id = ? AND page_id = ?")
        .bind(sourceId, pageId)
        .run();
      await clearPageChunks(db, sourceId, pageId);
      const inserted = await insertChunks({
        env,
        db,
        vectors,
        sourceId,
        pageId,
        title,
        chunks,
        indexedAt,
      });
      chunkCount += inserted.chunkCount;
      if (vectors.length > 0) {
        await upsertVectors(env, vectors);
      }
      const newChunkIds = new Set(vectors.map((vector) => vector.id));
      await deleteStaleVectors(
        env,
        oldChunkIds.filter((chunkId) => !newChunkIds.has(chunkId)),
      );
      await db
        .prepare(
          `INSERT OR REPLACE INTO notion_pages
            (page_id, source_id, title, url, parent_page_id, last_edited_time, content_hash, embedding_model, indexed_at, last_seen_at, is_deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .bind(
          pageId,
          sourceId,
          title,
          url,
          extractParentPageId(page),
          page.last_edited_time ?? null,
          contentHash,
          embeddingModel,
          indexedAt,
          indexedAt,
        )
        .run();
    }

    return {
      kind: "page",
      pageCount: 1,
      pageId,
      chunkCount,
      externalUrls: extractExternalUrlsFromBlocks(blocks).slice(0, maxExternalLinksPerSource),
      childPageIds: extractChildPageIds(blocks),
      databaseIds: extractChildDatabaseIds(blocks),
      discoveryComplete,
    };
  } catch (error) {
    throw new Error(`notion_page_index_failed:${page.id}:${String(error)}`);
  }
}

async function removeNotionPageFromIndex(
  env: NotionRagMcpBindings,
  sourceId: string,
  pageId: string,
) {
  const db = requireNotionRagDb(env);
  await deleteStaleVectors(env, await getPageChunkIds(db, sourceId, pageId));
  await clearPageChunks(db, sourceId, pageId);
  await db
    .prepare("UPDATE notion_pages SET is_deleted = 1 WHERE source_id = ? AND page_id = ?")
    .bind(sourceId, pageId)
    .run();
}

export async function markUnseenPagesDeleted(
  env: NotionRagMcpBindings,
  sourceId: string,
  indexedAt: string,
) {
  const db = requireNotionRagDb(env);
  const stalePages = await db
    .prepare(
      `SELECT page_id
         FROM notion_pages
        WHERE source_id = ?
          AND is_deleted = 0
          AND (last_seen_at IS NULL OR last_seen_at <> ?)`,
    )
    .bind(sourceId, indexedAt)
    .all<{ readonly page_id: string }>();
  for (const page of stalePages.results) {
    await deleteStaleVectors(env, await getPageChunkIds(db, sourceId, page.page_id));
    await clearPageChunks(db, sourceId, page.page_id);
    await db
      .prepare("UPDATE notion_pages SET is_deleted = 1 WHERE source_id = ? AND page_id = ?")
      .bind(sourceId, page.page_id)
      .run();
  }
}

async function getPageChunkIds(
  db: ReturnType<typeof requireNotionRagDb>,
  sourceId: string,
  pageId: string,
) {
  const rows = await db
    .prepare("SELECT chunk_id FROM notion_chunks WHERE source_id = ? AND page_id = ?")
    .bind(sourceId, pageId)
    .all<{ readonly chunk_id: string }>();
  return rows.results.map((row) => row.chunk_id);
}
