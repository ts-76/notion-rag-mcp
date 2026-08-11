import type { NotionRagMcpBindings } from "../../worker/bindings";
import { requireNotionRagDb, upsertStoredPageVectors } from "./storage";
import type { ReindexWorkflowStep } from "./workflow-types";

export async function repairNotionSourceVectors(
  env: NotionRagMcpBindings,
  sourceId: string,
  step: ReindexWorkflowStep,
) {
  const pageIds = await step.do("prepare notion vector repair", async () => {
    const db = requireNotionRagDb(env);
    const source = await db
      .prepare("SELECT id FROM notion_sources WHERE id = ? AND is_enabled = 1")
      .bind(sourceId)
      .first<{ readonly id: string }>();
    if (!source) {
      throw new Error("notion_source_not_found");
    }
    const rows = await db
      .prepare(
        `SELECT DISTINCT page_id
           FROM notion_chunks
          WHERE source_id = ?
          ORDER BY page_id ASC`,
      )
      .bind(sourceId)
      .all<{ readonly page_id: string }>();
    return rows.results.map((row) => row.page_id);
  });

  let repairedVectorCount = 0;
  for (const [index, pageId] of pageIds.entries()) {
    const repaired = await step.do(`repair notion vectors ${index + 1}-${pageId}`, async () =>
      upsertStoredPageVectors(env, sourceId, pageId),
    );
    repairedVectorCount += repaired.vectorCount;
  }
  return { sourceId, repairedPageCount: pageIds.length, repairedVectorCount };
}
