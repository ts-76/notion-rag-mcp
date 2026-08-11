import type { NotionRagMcpBindings } from "../../worker/bindings";
import {
  extractChildDatabaseIds,
  extractChildPageIds,
  isNotionPageExcludedFromSearch,
  normalizeNotionId,
  type NotionPage,
} from "../notion/content";
import { createIndexingNotionClient, isNotionInaccessibleDatabaseError } from "../notion/client";
import { maxBlocksPerPage } from "./config";
import { MAX_INDEXED_PAGES } from "./limits";
import type {
  NotionIndexDiscoveryClient,
  NotionPageDiscoveryResult,
  PageToIndexRef,
} from "./workflow-types";

export async function discoverNotionPageRefs(
  client: NotionIndexDiscoveryClient,
  rootPageId: string,
  limit = MAX_INDEXED_PAGES,
) {
  return (await discoverNotionPageRefsWithStatus(client, rootPageId, limit)).pageRefs;
}

async function discoverNotionPageRefsWithStatus(
  client: NotionIndexDiscoveryClient,
  rootPageId: string,
  limit = MAX_INDEXED_PAGES,
) {
  const pageRefs: PageToIndexRef[] = [];
  const seenPageIds = new Set<string>();
  const seenDatabaseIds = new Set<string>();
  const pendingPageIds = [normalizeNotionId(rootPageId)];
  let complete = true;

  while (pendingPageIds.length > 0 && pageRefs.length < limit) {
    const requestedPageId = pendingPageIds.shift();
    if (!requestedPageId || seenPageIds.has(requestedPageId)) {
      continue;
    }

    const page = await client.retrievePage(requestedPageId);
    const pageId = normalizeNotionId(page.id);
    if (seenPageIds.has(pageId)) {
      continue;
    }
    seenPageIds.add(pageId);
    if (isNotionPageExcludedFromSearch(page)) {
      continue;
    }
    pageRefs.push({ pageId });

    const blockResult = client.listPageBlocksWithStatus
      ? await client.listPageBlocksWithStatus(pageId, maxBlocksPerPage)
      : await client.listPageBlocks(pageId, maxBlocksPerPage).then((blocks) => ({
          blocks,
          truncated: blocks.length >= maxBlocksPerPage,
        }));
    const blocks = blockResult.blocks;
    complete &&= !blockResult.truncated;
    pendingPageIds.push(
      ...extractChildPageIds(blocks).filter((childPageId) => !seenPageIds.has(childPageId)),
    );

    for (const databaseId of extractChildDatabaseIds(blocks)) {
      if (seenDatabaseIds.has(databaseId)) {
        continue;
      }
      seenDatabaseIds.add(databaseId);
      let databasePages: readonly NotionPage[];
      try {
        const database = await client.retrieveDatabase(databaseId);
        databasePages = await client.queryDatabasePages(database, {
          limit: Math.max(0, limit - pageRefs.length),
        });
      } catch (error) {
        if (!isNotionInaccessibleDatabaseError(error)) {
          throw error;
        }
        continue;
      }
      pendingPageIds.push(
        ...databasePages
          .map((databasePage) => normalizeNotionId(databasePage.id))
          .filter((databasePageId) => !seenPageIds.has(databasePageId)),
      );
    }
  }
  return { pageRefs, complete: complete && pendingPageIds.length === 0 };
}

export async function discoverNotionPageForWorkflow(
  env: NotionRagMcpBindings,
  requestedPageId: string,
): Promise<NotionPageDiscoveryResult> {
  const client = createIndexingNotionClient(env);
  const page = await client.retrievePage(requestedPageId);
  const pageId = normalizeNotionId(page.id);
  if (isNotionPageExcludedFromSearch(page)) {
    return {
      pageId,
      childPageIds: [],
      databaseIds: [],
      truncated: false,
    };
  }
  const blockResult = await client.listPageBlocksWithStatus(pageId, maxBlocksPerPage);
  return {
    pageId,
    childPageIds: extractChildPageIds(blockResult.blocks),
    databaseIds: extractChildDatabaseIds(blockResult.blocks),
    truncated: blockResult.truncated,
  };
}

export async function discoverNotionDatabaseForWorkflow(
  env: NotionRagMcpBindings,
  databaseId: string,
  limit: number,
) {
  const client = createIndexingNotionClient(env);
  try {
    const database = await client.retrieveDatabase(databaseId);
    const databasePages = await client.queryDatabasePages(database, { limit });
    return databasePages.map((page) => normalizeNotionId(page.id));
  } catch (error) {
    if (!isNotionInaccessibleDatabaseError(error)) {
      throw error;
    }
    return [];
  }
}
