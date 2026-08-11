import type {
  NotionRagMcpBindings,
  NotionReindexWorkflowPayload,
} from "../../worker/bindings";
import { extractNotionPageTitle, normalizeNotionId, type NotionPage } from "../notion/content";
import { createIndexingNotionClient } from "../notion/client";
import { discoverNotionPageRefs } from "./indexer";
import { MAX_INDEXED_PAGES } from "./limits";
import { requireNotionRagDb } from "./storage";

type NotionSourceRow = {
  readonly id: string;
  readonly name: string;
  readonly root_page_id: string;
};

type NotionPageAuditItem = {
  readonly pageId: string;
  readonly title: string;
  readonly url: string;
};

export async function auditNotionSourceIndex(input: {
  readonly env: NotionRagMcpBindings;
  readonly payload: NotionReindexWorkflowPayload;
}) {
  const db = requireNotionRagDb(input.env);
  const source = await db
    .prepare("SELECT * FROM notion_sources WHERE id = ? AND is_enabled = 1")
    .bind(input.payload.sourceId)
    .first<NotionSourceRow>();
  if (!source) {
    throw new Error("notion_source_not_found");
  }

  const client = createIndexingNotionClient(input.env);
  const rootPageId = normalizeNotionId(source.root_page_id);
  const visiblePages = new Map<string, NotionPageAuditItem>();
  const visiblePageRefs = await discoverNotionPageRefs(client, rootPageId);
  for (const pageRef of visiblePageRefs) {
    addAuditPage(visiblePages, await client.retrievePage(pageRef.pageId));
  }

  const indexedRows = await db
    .prepare(
      `SELECT page_id, title, url
         FROM notion_pages
        WHERE source_id = ? AND is_deleted = 0
        ORDER BY title ASC`,
    )
    .bind(source.id)
    .all<{ page_id: string; title: string; url: string | null }>();
  const indexedPages = new Map(
    indexedRows.results.map((row) => [
      normalizeNotionId(row.page_id),
      {
        pageId: normalizeNotionId(row.page_id),
        title: row.title,
        url: row.url ?? "",
      },
    ]),
  );

  const missingFromIndex = [...visiblePages.values()].filter(
    (page) => !indexedPages.has(page.pageId),
  );
  const indexedButNotInNotionSearch = [...indexedPages.values()].filter(
    (page) => !visiblePages.has(page.pageId),
  );

  return {
    sourceId: source.id,
    sourceName: source.name,
    rootPageId,
    notionVisiblePageCount: visiblePages.size,
    notionSearchReturnedPageCount: visiblePageRefs.length,
    indexedActivePageCount: indexedPages.size,
    missingFromIndexCount: missingFromIndex.length,
    indexedButNotInNotionSearchCount: indexedButNotInNotionSearch.length,
    searchLimitReached: visiblePageRefs.length >= MAX_INDEXED_PAGES,
    missingFromIndex: missingFromIndex.slice(0, 25),
    indexedButNotInNotionSearch: indexedButNotInNotionSearch.slice(0, 25),
  };
}

function addAuditPage(pages: Map<string, NotionPageAuditItem>, page: NotionPage) {
  const pageId = normalizeNotionId(page.id);
  pages.set(pageId, {
    pageId,
    title: extractNotionPageTitle(page),
    url: page.url ?? `https://www.notion.so/${pageId.replaceAll("-", "")}`,
  });
}
