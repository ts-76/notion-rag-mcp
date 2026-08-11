import type { NotionRagMcpBindings } from "../../worker/bindings";
import { requireNotionRagDb } from "../indexing/storage";
import { createIndexingNotionClient } from "../notion/client";
import { extractNotionPageTitle, normalizeNotionId } from "../notion/content";

type SourceRow = {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly root_page_id: string;
  readonly is_enabled: number;
  readonly last_indexed_at: string | null;
  readonly updated_at: string;
};

export async function upsertNotionSource(input: {
  readonly env: NotionRagMcpBindings;
  readonly pageId: string;
  readonly name?: string;
}) {
  const rootPageId = normalizeNotionId(input.pageId);
  const page = await createIndexingNotionClient(input.env).retrievePage(rootPageId);
  const now = new Date().toISOString();
  const sourceId = `notion-${rootPageId.replaceAll("-", "")}`;
  const name = input.name?.trim() || extractNotionPageTitle(page);
  await requireNotionRagDb(input.env)
    .prepare(
      `INSERT INTO notion_sources
         (id, org_id, name, root_page_id, is_enabled, created_at, updated_at)
       VALUES (?, 'default', ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         root_page_id = excluded.root_page_id,
         is_enabled = 1,
         updated_at = excluded.updated_at`,
    )
    .bind(sourceId, name, rootPageId, now, now)
    .run();
  return {
    sourceId,
    name,
    rootPageId,
    url: page.url ?? `https://www.notion.so/${rootPageId.replaceAll("-", "")}`,
  };
}

export async function listNotionSources(env: NotionRagMcpBindings) {
  const rows = await requireNotionRagDb(env)
    .prepare(
      `SELECT id, org_id, name, root_page_id, is_enabled, last_indexed_at, updated_at
         FROM notion_sources ORDER BY updated_at DESC, id ASC`,
    )
    .all<SourceRow>();
  return {
    sources: rows.results.map((source) => ({
      sourceId: source.id,
      name: source.name,
      rootPageId: source.root_page_id,
      enabled: source.is_enabled === 1,
      lastIndexedAt: source.last_indexed_at,
      updatedAt: source.updated_at,
    })),
  };
}
