import type { NotionRagMcpBindings } from "../../worker/bindings";
import {
  isNotionBlock,
  isNotionDatabase,
  isNotionPage,
  normalizeNotionId,
  readString,
  readUnknownRecord,
  type NotionBlock,
  type NotionDatabase,
  type NotionPage,
} from "../notion/content";

const notionRequestTimeoutMs = 30_000;
const maxBlockChildRequestsPerPage = 40;

type NotionRequestBudget = {
  remaining: number;
  exhausted: boolean;
};

export function createIndexingNotionClient(env: NotionRagMcpBindings) {
  if (!env.NOTION_API_TOKEN) {
    throw new Error("notion_token_missing");
  }
  const notionVersion = env.NOTION_API_VERSION ?? "2022-06-28";

  async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${env.NOTION_API_TOKEN}`);
    headers.set("notion-version", notionVersion);
    headers.set("content-type", "application/json");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`https://api.notion.com/v1${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(notionRequestTimeoutMs),
      });
      if (response.ok) {
        return (await response.json()) as T;
      }
      if (response.status === 429 && attempt < 3) {
        const parsedRetryAfter = Number(response.headers.get("retry-after") ?? "1");
        const retryAfterSeconds = Math.min(
          Math.max(Number.isFinite(parsedRetryAfter) ? parsedRetryAfter : 1, 1),
          30,
        );
        await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
        continue;
      }
      const body = await response.text();
      throw new Error(`notion_api_failed:${response.status}:${path}:${body.slice(0, 500)}`);
    }
    throw new Error(`notion_api_failed:429:${path}:retry_exhausted`);
  }

  async function retrievePage(pageId: string) {
    return requestJson<NotionPage>(`/pages/${encodeURIComponent(pageId)}`);
  }

  async function retrieveDatabase(databaseId: string) {
    return requestJson<NotionDatabase>(`/databases/${encodeURIComponent(databaseId)}`);
  }

  async function searchPages(query: string, limit: number) {
    return searchObjects<NotionPage>(query, limit, "page", isNotionPage);
  }

  async function searchDatabases(query: string, limit: number) {
    return searchObjects<NotionDatabase>(query, limit, "database", isNotionDatabase);
  }

  async function searchObjects<T>(
    query: string,
    limit: number,
    objectType: "page" | "database",
    predicate: (value: unknown) => value is T,
  ) {
    const objects: T[] = [];
    let cursor: string | undefined;
    do {
      const response = await requestJson<{ results?: unknown[]; next_cursor?: string | null }>(
        "/search",
        {
          method: "POST",
          body: JSON.stringify({
            ...(query ? { query } : {}),
            filter: { property: "object", value: objectType },
            page_size: Math.min(100, limit - objects.length),
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        },
      );
      objects.push(...(response.results ?? []).filter(predicate));
      cursor = response.next_cursor ?? undefined;
    } while (cursor && objects.length < limit);
    return objects.slice(0, limit);
  }

  async function queryDatabasePages(
    database: Pick<NotionDatabase, "data_sources" | "id">,
    input: { readonly limit: number },
  ) {
    if (input.limit <= 0) {
      return [];
    }
    const databaseId = normalizeNotionId(database.id);
    const pages: NotionPage[] = [];
    const dataSourceIds = await resolveDatabaseDataSourceIds(database);
    for (const dataSourceId of dataSourceIds) {
      try {
        pages.push(
          ...(await queryPaginatedPages(
            `/data_sources/${encodeURIComponent(dataSourceId)}/query`,
            input.limit - pages.length,
          )),
        );
      } catch (error) {
        if (!isNotionDataSourceQueryFallbackError(error)) {
          throw error;
        }
      }
      if (pages.length >= input.limit) {
        return pages.slice(0, input.limit);
      }
    }
    if (pages.length > 0) {
      return pages.slice(0, input.limit);
    }
    try {
      return await queryPaginatedPages(
        `/databases/${encodeURIComponent(databaseId)}/query`,
        input.limit,
      );
    } catch (error) {
      if (isNotionInaccessibleDatabaseError(error)) {
        return [];
      }
      throw error;
    }
  }

  async function resolveDatabaseDataSourceIds(
    database: Pick<NotionDatabase, "data_sources" | "id">,
  ) {
    const inlineIds = extractDatabaseDataSourceIds(database);
    if (inlineIds.length > 0) {
      return inlineIds;
    }
    try {
      return extractDatabaseDataSourceIds(await retrieveDatabase(normalizeNotionId(database.id)));
    } catch (error) {
      if (!isNotionDataSourceQueryFallbackError(error)) {
        throw error;
      }
      return [];
    }
  }

  async function queryPaginatedPages(path: string, limit: number) {
    const pages: NotionPage[] = [];
    let cursor: string | undefined;
    do {
      const response = await requestJson<{ results?: unknown[]; next_cursor?: string | null }>(
        path,
        {
          method: "POST",
          body: JSON.stringify({
            page_size: Math.min(100, limit - pages.length),
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        },
      );
      pages.push(...(response.results ?? []).filter(isNotionPage));
      cursor = response.next_cursor ?? undefined;
    } while (cursor && pages.length < limit);
    return pages.slice(0, limit);
  }

  async function listPageBlocks(pageId: string, maxBlocks: number) {
    return (await listPageBlocksWithStatus(pageId, maxBlocks)).blocks;
  }

  async function listPageBlocksWithStatus(pageId: string, maxBlocks: number) {
    const collected: NotionBlock[] = [];
    const queue = [pageId];
    const requestBudget: NotionRequestBudget = {
      remaining: maxBlockChildRequestsPerPage,
      exhausted: false,
    };
    while (queue.length > 0 && collected.length < maxBlocks && !requestBudget.exhausted) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      const blocks = await listBlockChildren(current, maxBlocks - collected.length, requestBudget);
      collected.push(...blocks);
      queue.push(
        ...blocks
          .filter(
            (block) =>
              block.has_children && block.type !== "child_page" && block.type !== "child_database",
          )
          .map((block) => block.id),
      );
    }
    return {
      blocks: collected,
      truncated: requestBudget.exhausted || collected.length >= maxBlocks || queue.length > 0,
    };
  }

  async function listBlockChildren(
    blockId: string,
    limit: number,
    requestBudget?: NotionRequestBudget,
  ) {
    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;
    do {
      if (requestBudget && requestBudget.remaining <= 0) {
        requestBudget.exhausted = true;
        break;
      }
      if (requestBudget) {
        requestBudget.remaining -= 1;
      }
      const params = new URLSearchParams({ page_size: "100" });
      if (cursor) {
        params.set("start_cursor", cursor);
      }
      const response = await requestJson<{ results?: unknown[]; next_cursor?: string | null }>(
        `/blocks/${encodeURIComponent(blockId)}/children?${params.toString()}`,
        { method: "GET" },
      );
      blocks.push(...(response.results ?? []).filter(isNotionBlock));
      cursor = response.next_cursor ?? undefined;
    } while (cursor && blocks.length < limit);
    return blocks.slice(0, limit);
  }

  async function listBlockChildrenPage(blockId: string, cursor?: string) {
    const params = new URLSearchParams({ page_size: "100" });
    if (cursor) {
      params.set("start_cursor", cursor);
    }
    const response = await requestJson<{ results?: unknown[]; next_cursor?: string | null }>(
      `/blocks/${encodeURIComponent(blockId)}/children?${params.toString()}`,
      { method: "GET" },
    );
    return {
      blocks: (response.results ?? []).filter(isNotionBlock),
      nextCursor: response.next_cursor ?? undefined,
    };
  }

  return {
    listBlockChildrenPage,
    listPageBlocks,
    listPageBlocksWithStatus,
    queryDatabasePages,
    retrieveDatabase,
    retrievePage,
    searchDatabases,
    searchPages,
  };
}

export function isPermanentNotionAccessError(error: unknown) {
  const message = String(error);
  return message.includes("notion_api_failed:403") || message.includes("notion_api_failed:404");
}

function isNotionDataSourceQueryFallbackError(error: unknown) {
  const message = String(error);
  return message.includes("notion_api_failed:400") || message.includes("notion_api_failed:404");
}

export function isNotionInaccessibleDatabaseError(error: unknown) {
  const message = String(error);
  return (
    message.includes("notion_api_failed:400") &&
    message.includes("does not contain any data sources accessible")
  );
}

function extractDatabaseDataSourceIds(database: Pick<NotionDatabase, "data_sources">) {
  if (!Array.isArray(database.data_sources)) {
    return [];
  }
  return database.data_sources
    .map((dataSource) => readString(readUnknownRecord(dataSource)?.id))
    .filter((id): id is string => typeof id === "string")
    .map((id) => normalizeNotionId(id));
}
