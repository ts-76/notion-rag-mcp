import type { NotionRagMcpBindings, VectorizeVector } from "../../worker/bindings";
import { fetchExternalMarkdown } from "../external-content/browser-markdown";
import { createExternalMarkdownChunks, isIndexableExternalUrl, sha256Hex } from "../notion/content";
import {
  clearPageChunks,
  deleteStaleVectors,
  getNotionEmbeddingModel,
  requireNotionRagDb,
  reserveVectorizeUpsertBudget,
  upsertVectors,
  VectorizeUpsertBudgetError,
} from "./storage";
import { insertChunks } from "./chunks";

export type ExternalLinkToIndex = {
  readonly parentPageId: string;
  readonly url: string;
};

export async function indexExternalLinks(input: {
  readonly env: NotionRagMcpBindings;
  readonly sourceId: string;
  readonly links: readonly ExternalLinkToIndex[];
  readonly indexedAt: string;
}) {
  const db = requireNotionRagDb(input.env);
  const allowedHosts = new Set(
    (input.env.NOTION_EXTERNAL_HOST_ALLOWLIST ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  let externalLinkCount = 0;
  let chunkCount = 0;
  for (const link of input.links.filter(
    (item) =>
      isIndexableExternalUrl(item.url) &&
      allowedHosts.has(new URL(item.url).hostname.toLowerCase()),
  )) {
    const documentId = await createExternalDocumentId(input.sourceId, link.url);
    const priorChunkIds = await getExternalChunkIds(db, input.sourceId, documentId);
    try {
      if (!input.env.BROWSER) {
        throw new Error("browser_binding_missing");
      }
      const document = await fetchExternalMarkdown({
        browser: input.env.BROWSER,
        url: link.url,
        allowedHosts,
      });
      const markdown = `Source URL: ${document.finalUrl}\n\n${document.markdown}`;
      const chunks = createExternalMarkdownChunks(document.title, markdown);
      const contentHash = await sha256Hex(chunks.join("\n\n"));
      const embeddingModel = getNotionEmbeddingModel(input.env);
      const existing = await db
        .prepare(
          `SELECT d.content_hash, p.embedding_model, p.is_deleted AS page_is_deleted
             FROM notion_external_documents d
             LEFT JOIN notion_pages p
               ON p.source_id = d.source_id AND p.page_id = d.document_id
            WHERE d.document_id = ? AND d.source_id = ?`,
        )
        .bind(documentId, input.sourceId)
        .first<{
          readonly content_hash: string | null;
          readonly embedding_model: string | null;
          readonly page_is_deleted: number | null;
        }>();
      if (
        existing?.content_hash !== contentHash ||
        existing.embedding_model !== embeddingModel ||
        existing.page_is_deleted !== 0
      ) {
        await reserveVectorizeUpsertBudget(input.env, chunks.length);
        const vectors: VectorizeVector[] = [];
        await db
          .prepare("UPDATE notion_pages SET is_deleted = 1 WHERE source_id = ? AND page_id = ?")
          .bind(input.sourceId, documentId)
          .run();
        await clearPageChunks(db, input.sourceId, documentId);
        const inserted = await insertChunks({
          env: input.env,
          db,
          vectors,
          sourceId: input.sourceId,
          pageId: documentId,
          title: document.title,
          chunks,
          indexedAt: input.indexedAt,
        });
        chunkCount += inserted.chunkCount;
        if (vectors.length > 0) {
          await upsertVectors(input.env, vectors);
        }
        const newChunkIds = new Set(vectors.map((vector) => vector.id));
        await deleteStaleVectors(
          input.env,
          priorChunkIds.filter((chunkId) => !newChunkIds.has(chunkId)),
        );
        await db
          .prepare(
            `INSERT OR REPLACE INTO notion_pages
              (page_id, source_id, title, url, parent_page_id, last_edited_time, content_hash, embedding_model, indexed_at, last_seen_at, is_deleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          )
          .bind(
            documentId,
            input.sourceId,
            document.title,
            document.finalUrl,
            link.parentPageId,
            null,
            contentHash,
            embeddingModel,
            input.indexedAt,
            input.indexedAt,
          )
          .run();
      } else {
        await db
          .prepare(
            `UPDATE notion_pages
                SET last_seen_at = ?, indexed_at = ?, is_deleted = 0
              WHERE page_id = ? AND source_id = ?`,
          )
          .bind(input.indexedAt, input.indexedAt, documentId, input.sourceId)
          .run();
      }
      await db
        .prepare(
          `INSERT OR REPLACE INTO notion_external_documents
            (document_id, source_id, parent_page_id, url, title, markdown, content_hash, status, fetched_at, error_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          documentId,
          input.sourceId,
          link.parentPageId,
          document.finalUrl,
          document.title,
          markdown,
          contentHash,
          "succeeded",
          input.indexedAt,
          null,
        )
        .run();
      externalLinkCount += 1;
    } catch (error) {
      if (error instanceof VectorizeUpsertBudgetError) {
        throw error;
      }
      const currentChunkIds = await getExternalChunkIds(db, input.sourceId, documentId);
      await deleteStaleVectors(input.env, [...new Set([...priorChunkIds, ...currentChunkIds])]);
      await clearPageChunks(db, input.sourceId, documentId);
      await db
        .prepare(
          `INSERT OR REPLACE INTO notion_external_documents
            (document_id, source_id, parent_page_id, url, title, markdown, content_hash, status, fetched_at, error_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          documentId,
          input.sourceId,
          link.parentPageId,
          link.url,
          new URL(link.url).hostname,
          "",
          await sha256Hex(""),
          "failed",
          input.indexedAt,
          String(error).slice(0, 1000),
        )
        .run();
      await db
        .prepare(
          `UPDATE notion_pages
              SET is_deleted = 1
            WHERE page_id = ? AND source_id = ?`,
        )
        .bind(documentId, input.sourceId)
        .run();
      externalLinkCount += 1;
    }
  }
  return { chunkCount, externalLinkCount };
}

async function getExternalChunkIds(
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

async function createExternalDocumentId(sourceId: string, url: string) {
  const hash = await sha256Hex(`${sourceId}:${url}`);
  return `x:${hash.slice(0, 32)}`;
}
