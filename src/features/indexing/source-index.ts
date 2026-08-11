import type {
  NotionRagMcpBindings,
  NotionIndexWorkItemWorkflowPayload,
} from "../../worker/bindings";
import { normalizeNotionId } from "../notion/content";
import {
  maxExternalLinksPerSource,
  maxExternalLinksPerStep,
  workflowYieldDuration,
} from "./config";
import type { ExternalLinkToIndex } from "./external-documents";
import { MAX_INDEXED_PAGES } from "./limits";
import { markUnseenPagesDeleted } from "./page-persistence";
import { requireNotionRagDb } from "./storage";
import {
  launchIndexWorkItems,
  loadIndexWorkItemResultRows,
  loadIndexWorkItemResults,
  waitForIndexWorkItems,
} from "./work-item-store";
import { runNotionWorkflowStep } from "./workflow-step";
import type {
  ExternalIndexResult,
  NotionPageDiscoveryResult,
  NotionPageIndexResult,
  NotionSourceRow,
  PageIndexResult,
  PageToIndexRef,
  PageWorkItemResult,
  ReindexWorkflowStep,
} from "./workflow-types";

export async function indexNotionSource(
  env: NotionRagMcpBindings,
  source: NotionSourceRow,
  step: ReindexWorkflowStep,
  jobId: string,
) {
  if (!env.NOTION_INDEX_WORK_ITEM_WORKFLOW) {
    return await indexNotionSourceDirect(env, source, step);
  }

  const prepared = await step.do("prepare notion source index", async () => {
    return { indexedAt: new Date().toISOString() };
  });
  const pendingPageIds = [normalizeNotionId(source.root_page_id)];
  const pendingDatabaseIds: string[] = [];
  const seenPageIds = new Set<string>();
  const seenDatabaseIds = new Set<string>();
  const pageResults: PageIndexResult[] = [];
  let nextPageItem = 1;
  let nextDatabaseItem = 1;
  let discoveryComplete = true;
  let wave = 0;

  while (
    (pendingPageIds.length > 0 || pendingDatabaseIds.length > 0) &&
    seenPageIds.size < MAX_INDEXED_PAGES
  ) {
    const payloads: NotionIndexWorkItemWorkflowPayload[] = [];
    while (pendingPageIds.length > 0 && seenPageIds.size < MAX_INDEXED_PAGES) {
      const pageId = pendingPageIds.shift();
      if (!pageId || seenPageIds.has(pageId)) {
        continue;
      }
      seenPageIds.add(pageId);
      payloads.push({
        jobId,
        itemId: `page-${String(nextPageItem).padStart(4, "0")}`,
        itemType: "page",
        sourceId: source.id,
        indexedAt: prepared.indexedAt,
        pageId,
      });
      nextPageItem += 1;
    }
    while (pendingDatabaseIds.length > 0) {
      const databaseId = pendingDatabaseIds.shift();
      if (!databaseId || seenDatabaseIds.has(databaseId)) {
        continue;
      }
      seenDatabaseIds.add(databaseId);
      payloads.push({
        jobId,
        itemId: `database-${String(nextDatabaseItem).padStart(4, "0")}`,
        itemType: "page",
        sourceId: source.id,
        indexedAt: prepared.indexedAt,
        databaseId,
      });
      nextDatabaseItem += 1;
    }
    if (payloads.length === 0) {
      break;
    }

    wave += 1;
    await step.do(`launch notion page workflow wave ${wave}`, async () => {
      await launchIndexWorkItems(env, jobId, payloads);
    });
    await waitForIndexWorkItems(env, step, jobId, "page", `page wave ${wave}`);

    const waveItemIds = new Set(payloads.map((payload) => payload.itemId));
    const rows = await step.do(`collect notion page workflow wave ${wave}`, async () =>
      loadIndexWorkItemResultRows(env, jobId, "page"),
    );
    for (const row of rows) {
      if (!waveItemIds.has(row.item_id) || !row.result_json) {
        continue;
      }
      const result = JSON.parse(row.result_json) as PageWorkItemResult;
      if (result.kind === "database") {
        pendingPageIds.push(...result.pageIds.map(normalizeNotionId));
        continue;
      }
      pageResults.push(result);
      discoveryComplete &&= result.discoveryComplete;
      pendingPageIds.push(...result.childPageIds.map(normalizeNotionId));
      pendingDatabaseIds.push(...result.databaseIds.map(normalizeNotionId));
    }
  }
  discoveryComplete &&=
    pendingPageIds.length === 0 &&
    pendingDatabaseIds.length === 0 &&
    seenPageIds.size < MAX_INDEXED_PAGES;

  const externalLinks = deduplicateExternalLinks(
    pageResults.flatMap((result) =>
      result.externalUrls.map((url) => ({ parentPageId: result.pageId, url })),
    ),
  ).slice(0, maxExternalLinksPerSource);

  if (externalLinks.length > 0) {
    await step.do("launch notion external link workflows", async () => {
      const payloads: NotionIndexWorkItemWorkflowPayload[] = [];
      for (let index = 0; index < externalLinks.length; index += maxExternalLinksPerStep) {
        payloads.push({
          jobId,
          itemId: `external-${String(payloads.length + 1).padStart(3, "0")}`,
          itemType: "external",
          sourceId: source.id,
          indexedAt: prepared.indexedAt,
          links: externalLinks.slice(index, index + maxExternalLinksPerStep),
        });
      }
      await launchIndexWorkItems(env, jobId, payloads);
    });
    await waitForIndexWorkItems(env, step, jobId, "external", "external");
  }

  const externalResults =
    externalLinks.length === 0
      ? []
      : await step.do("collect notion external link workflow results", async () =>
          loadIndexWorkItemResults<ExternalIndexResult>(env, jobId, "external"),
        );
  const indexedPageCount = pageResults.reduce((sum, result) => sum + result.pageCount, 0);
  const indexedChunkCount =
    pageResults.reduce((sum, result) => sum + result.chunkCount, 0) +
    externalResults.reduce((sum, result) => sum + result.chunkCount, 0);
  const indexedExternalLinkCount = externalResults.reduce(
    (sum, result) => sum + result.externalLinkCount,
    0,
  );

  return await finalizeNotionSourceIndex(
    env,
    source,
    prepared,
    {
      pageCount: indexedPageCount,
      chunkCount: indexedChunkCount,
      externalLinkCount: indexedExternalLinkCount,
    },
    discoveryComplete,
    step,
  );
}

async function indexNotionSourceDirect(
  env: NotionRagMcpBindings,
  source: NotionSourceRow,
  step: ReindexWorkflowStep,
) {
  const discovery = await discoverNotionPagesForIndex(env, source, step);
  const pageRefs = discovery.pageRefs;
  const prepared = await step.do("prepare notion source index", async () => {
    return { indexedAt: new Date().toISOString() };
  });

  let indexedPageCount = 0;
  let indexedChunkCount = 0;
  const externalLinks: ExternalLinkToIndex[] = [];
  for (const [index, pageRef] of pageRefs.entries()) {
    const result = await step.do(`index notion page ${index + 1}-${pageRef.pageId}`, async () =>
      runNotionWorkflowStep<NotionPageIndexResult>(env, {
        type: "index-page",
        sourceId: source.id,
        pageId: pageRef.pageId,
        indexedAt: prepared.indexedAt,
      }),
    );
    indexedPageCount += result.pageCount;
    indexedChunkCount += result.chunkCount;
    externalLinks.push(...result.externalUrls.map((url) => ({ parentPageId: result.pageId, url })));
    await step.sleep(`yield after notion page ${index + 1}`, workflowYieldDuration);
  }

  let indexedExternalLinkCount = 0;
  const limitedExternalLinks = externalLinks.slice(0, maxExternalLinksPerSource);
  for (let index = 0; index < limitedExternalLinks.length; index += maxExternalLinksPerStep) {
    const links = limitedExternalLinks.slice(index, index + maxExternalLinksPerStep);
    const result = await step.do(
      `index external links ${index + 1}-${index + links.length}`,
      async () =>
        runNotionWorkflowStep<{ readonly chunkCount: number; readonly externalLinkCount: number }>(
          env,
          {
            type: "index-external-links",
            sourceId: source.id,
            links,
            indexedAt: prepared.indexedAt,
          },
        ),
    );
    indexedChunkCount += result.chunkCount;
    indexedExternalLinkCount += result.externalLinkCount;
    await step.sleep(
      `yield after external links ${index + 1}-${index + links.length}`,
      workflowYieldDuration,
    );
  }

  return await finalizeNotionSourceIndex(
    env,
    source,
    prepared,
    {
      pageCount: indexedPageCount,
      chunkCount: indexedChunkCount,
      externalLinkCount: indexedExternalLinkCount,
    },
    discovery.complete && pageRefs.length < MAX_INDEXED_PAGES,
    step,
  );
}

async function finalizeNotionSourceIndex(
  env: NotionRagMcpBindings,
  source: NotionSourceRow,
  prepared: { readonly indexedAt: string },
  indexed: {
    readonly pageCount: number;
    readonly chunkCount: number;
    readonly externalLinkCount: number;
  },
  canDeleteUnseenPages: boolean,
  step: ReindexWorkflowStep,
) {
  return await step.do("finalize notion source index", async () => {
    if (canDeleteUnseenPages) {
      await markUnseenPagesDeleted(env, source.id, prepared.indexedAt);
    }
    await requireNotionRagDb(env)
      .prepare("UPDATE notion_sources SET last_indexed_at = ?, updated_at = ? WHERE id = ?")
      .bind(prepared.indexedAt, prepared.indexedAt, source.id)
      .run();
    return {
      pageCount: indexed.pageCount,
      chunkCount: indexed.chunkCount,
      externalLinkCount: indexed.externalLinkCount,
    };
  });
}

async function discoverNotionPagesForIndex(
  env: NotionRagMcpBindings,
  source: NotionSourceRow,
  step: ReindexWorkflowStep,
) {
  const pageRefs: PageToIndexRef[] = [];
  const seenPageIds = new Set<string>();
  const seenDatabaseIds = new Set<string>();
  const pendingPageIds = [normalizeNotionId(source.root_page_id)];
  let complete = true;

  while (pendingPageIds.length > 0 && pageRefs.length < MAX_INDEXED_PAGES) {
    const requestedPageId = pendingPageIds.shift();
    if (!requestedPageId || seenPageIds.has(requestedPageId)) {
      continue;
    }

    const pageDiscovery = await step.do(
      `discover notion page ${pageRefs.length + 1}-${requestedPageId}`,
      async () =>
        runNotionWorkflowStep<NotionPageDiscoveryResult>(env, {
          type: "discover-page",
          pageId: requestedPageId,
        }),
    );
    if (seenPageIds.has(pageDiscovery.pageId)) {
      continue;
    }
    seenPageIds.add(pageDiscovery.pageId);
    pageRefs.push({ pageId: pageDiscovery.pageId });
    complete &&= !pageDiscovery.truncated;
    pendingPageIds.push(...pageDiscovery.childPageIds.filter((pageId) => !seenPageIds.has(pageId)));

    for (const databaseId of pageDiscovery.databaseIds) {
      if (seenDatabaseIds.has(databaseId)) {
        continue;
      }
      seenDatabaseIds.add(databaseId);
      const databasePageIds = await step.do(
        `discover notion database ${seenDatabaseIds.size}-${databaseId}`,
        async () =>
          runNotionWorkflowStep<readonly string[]>(env, {
            type: "discover-database",
            databaseId,
            limit: Math.max(0, MAX_INDEXED_PAGES - pageRefs.length),
          }),
      );
      pendingPageIds.push(...databasePageIds.filter((pageId) => !seenPageIds.has(pageId)));
    }
  }

  return { pageRefs, complete: complete && pendingPageIds.length === 0 };
}

function deduplicateExternalLinks(links: readonly ExternalLinkToIndex[]) {
  const unique = new Map<string, ExternalLinkToIndex>();
  for (const link of links) {
    if (!unique.has(link.url)) {
      unique.set(link.url, link);
    }
  }
  return [...unique.values()];
}
