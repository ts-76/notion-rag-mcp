import type { NotionRagMcpBindings } from "../../worker/bindings";
import { requireNotionRagDb } from "../indexing/storage";
import { normalizeNotionId } from "../notion/content";
import type { NotionChunkRow, NotionPageRow } from "./types";

export async function getIndexedNotionPage(
  env: NotionRagMcpBindings,
  rawPageId: string,
) {
  const pageId = normalizeNotionId(rawPageId);
  const db = requireNotionRagDb(env);
  const page = await db
    .prepare(
      `SELECT * FROM notion_pages
        WHERE page_id = ? AND is_deleted = 0
        ORDER BY source_id ASC LIMIT 1`,
    )
    .bind(pageId)
    .first<NotionPageRow>();
  if (!page) {
    return null;
  }
  const chunks = await db
    .prepare(
      `SELECT * FROM notion_chunks
        WHERE source_id = ? AND page_id = ? ORDER BY chunk_index ASC`,
    )
    .bind(page.source_id, page.page_id)
    .all<NotionChunkRow>();
  return {
    pageId: page.page_id,
    sourceId: page.source_id,
    title: page.title,
    url: page.url ?? "",
    lastEditedTime: page.last_edited_time ?? "",
    indexedAt: page.indexed_at ?? "",
    text: chunks.results.map((chunk) => chunk.text).join("\n\n"),
  };
}
