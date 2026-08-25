import { afterEach, describe, expect, test, vi } from "vitest";
import {
  runNotionIndexWorkItemWorkflow,
  runNotionReindexWorkflow,
} from "../features/indexing/indexer";
import { indexExternalLinks } from "../features/indexing/external-documents";
import { persistNotionPageIndex } from "../features/indexing/page-persistence";
import {
  reserveVectorizeUpsertBudget,
  upsertStoredPageVectors,
} from "../features/indexing/storage";
import { repairNotionSourceVectors } from "../features/indexing/vector-repair";
import { createIndexingNotionClient } from "../features/notion/client";
import {
  createExternalMarkdownChunks,
  createNotionPageChunks,
  sha256Hex,
  type NotionBlock,
} from "../features/notion/content";
import { notionRagMcpApplicationWorker } from "../worker/application";
import type {
  CloudflareD1Database,
  CloudflareD1PreparedStatement,
  NotionRagMcpBindings,
  NotionIndexWorkItemWorkflowPayload,
  VectorizeVector,
} from "../worker/bindings";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {},
}));

vi.mock("../features/external-content/browser-markdown", () => ({
  fetchExternalMarkdown: vi.fn(async ({ url }: { readonly url: string }) => ({
    title: new URL(url).hostname,
    markdown: "External documentation body.",
    finalUrl: url,
  })),
}));

const rootPageId = "11111111-1111-1111-1111-111111111111";
const secondPageId = "22222222-2222-2222-2222-222222222222";
const databaseId = "33333333-3333-3333-3333-333333333333";

describe("Notion reindex Workflow orchestration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("isolates pages and external links in deterministic steps and batches bindings", async () => {
    vi.stubGlobal("fetch", vi.fn(handleNotionRequest));
    const db = new FakeD1();
    const ai = new FakeAi();
    const vectorize = new FakeVectorize();
    const step = new FakeWorkflowStep();
    let serviceCallCount = 0;
    const env: NotionRagMcpBindings = {
      NOTION_RAG_DB: db,
      NOTION_VECTORIZE: vectorize,
      AI: ai,
      BROWSER: {},
      NOTION_EXTERNAL_HOST_ALLOWLIST: "docs.example.test",
      NOTION_API_TOKEN: "test-token",
      NOTION_INDEX_SERVICE: {
        async fetch(request) {
          serviceCallCount += 1;
          return await notionRagMcpApplicationWorker.fetch(request, env);
        },
      },
    };

    const result = await runNotionReindexWorkflow({
      env,
      payload: {
        jobId: "job-1",
        sourceId: "source-1",
        actorUserId: "user-1",
        orgId: "org-1",
      },
      step,
    });

    expect(result).toMatchObject({
      indexedPageCount: 2,
      indexedExternalLinkCount: 6,
    });
    expect(serviceCallCount).toBe(7);
    expect(step.names).toEqual([
      `discover notion page 1-${rootPageId}`,
      `discover notion database 1-${databaseId}`,
      `discover notion page 2-${secondPageId}`,
      "prepare notion source index",
      `index notion page 1-${rootPageId}`,
      `index notion page 2-${secondPageId}`,
      "index external links 1-3",
      "index external links 4-6",
      "finalize notion source index",
    ]);
    expect(step.sleepNames).toEqual([
      "yield after notion page 1",
      "yield after notion page 2",
      "yield after external links 1-3",
      "yield after external links 4-6",
    ]);
    expect(step.sleepDurations).toEqual(["1 second", "1 second", "1 second", "1 second"]);
    expect(ai.calls.some((batch) => batch.length === 50)).toBe(true);
    expect(ai.calls.every((batch) => batch.length <= 50)).toBe(true);
    expect(db.batches.length).toBeGreaterThan(0);
    expect(db.batches.every((batch) => batch.length <= 50)).toBe(true);
    expect(vectorize.upserts.length).toBeGreaterThan(0);
    expect(vectorize.upserts.every((batch) => batch.length <= 50)).toBe(true);
  });

  test("fans page and external indexing out to child Workflow instances", async () => {
    vi.stubGlobal("fetch", vi.fn(handleNotionRequest));
    const db = new FakeD1();
    const ai = new FakeAi();
    const vectorize = new FakeVectorize();
    const step = new FakeWorkflowStep();
    let env!: NotionRagMcpBindings;
    const workItems = new FakeIndexWorkItemWorkflowBinding(() => env);
    env = {
      NOTION_RAG_DB: db,
      NOTION_VECTORIZE: vectorize,
      AI: ai,
      BROWSER: {},
      NOTION_EXTERNAL_HOST_ALLOWLIST: "docs.example.test",
      NOTION_API_TOKEN: "test-token",
      NOTION_INDEX_WORK_ITEM_WORKFLOW: workItems,
    };

    const result = await runNotionReindexWorkflow({
      env,
      payload: {
        jobId: "job-distributed",
        sourceId: "source-1",
        actorUserId: "user-1",
        orgId: "org-1",
      },
      step,
    });

    expect(result).toMatchObject({
      indexedPageCount: 2,
      indexedExternalLinkCount: 6,
    });
    expect(workItems.created.filter((item) => item.params.itemType === "page")).toHaveLength(5);
    expect(workItems.created.some((item) => item.id.endsWith("page-0002-part-2"))).toBe(true);
    expect(workItems.created.some((item) => item.id.endsWith("page-0002-part-3"))).toBe(true);
    expect(workItems.created.filter((item) => item.params.itemType === "external")).toHaveLength(2);
    expect(step.names).toEqual([
      "prepare notion source index",
      "launch notion page workflow wave 1",
      "check notion page wave 1 workflows 1",
      "collect notion page workflow wave 1",
      "launch notion page workflow wave 2",
      "check notion page wave 2 workflows 1",
      "collect notion page workflow wave 2",
      "launch notion external link workflows",
      "check notion external workflows 1",
      "collect notion external link workflow results",
      "finalize notion source index",
    ]);
    expect(db.workItems.size).toBe(5);
    expect([...db.workItems.values()].every((item) => item.status === "succeeded")).toBe(true);
  });

  test.each([false, true])(
    "removes excluded pages from D1, FTS, and Vectorize (distributed=%s)",
    async (distributed) => {
      const fetchMock = vi.fn(handleExcludedPageNotionRequest);
      vi.stubGlobal("fetch", fetchMock);
      const db = new FakeD1();
      db.storedChunks.push({
        chunk_id: "excluded-old-chunk",
        chunk_index: 0,
        text: "Previously indexed excluded content",
      });
      const ai = new FakeAi();
      const vectorize = new FakeVectorize();
      const step = new FakeWorkflowStep();
      let env!: NotionRagMcpBindings;
      const workItems = new FakeIndexWorkItemWorkflowBinding(() => env);
      env = {
        NOTION_RAG_DB: db,
        NOTION_VECTORIZE: vectorize,
        AI: ai,
        NOTION_API_TOKEN: "test-token",
        ...(distributed ? { NOTION_INDEX_WORK_ITEM_WORKFLOW: workItems } : {}),
      };

      const result = await runNotionReindexWorkflow({
        env,
        payload: {
          jobId: distributed ? "job-excluded-distributed" : "job-excluded-direct",
          sourceId: "source-1",
          actorUserId: "user-1",
          orgId: "org-1",
        },
        step,
      });

      expect(result).toMatchObject({
        indexedPageCount: 1,
        indexedExternalLinkCount: 0,
      });
      expect(
        fetchMock.mock.calls.some(([input]) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL ? input : input.url,
          );
          return url.pathname === `/v1/blocks/${secondPageId}/children`;
        }),
      ).toBe(false);
      expect(vectorize.deletedIds).toContainEqual(["excluded-old-chunk"]);
      expect(
        db.runs.some((run) => run.query.includes("DELETE FROM notion_chunks WHERE source_id")),
      ).toBe(true);
      expect(
        db.runs.some((run) => run.query.includes("DELETE FROM notion_chunks_fts WHERE source_id")),
      ).toBe(true);
      expect(
        db.runs.some((run) => run.query.includes("UPDATE notion_pages SET is_deleted = 1")),
      ).toBe(true);
    },
  );

  test("repairs Vectorize from stored D1 chunks for unchanged pages", async () => {
    const db = new FakeD1();
    db.storedChunks.push(
      { chunk_id: "chunk-1", chunk_index: 0, text: "First stored chunk" },
      { chunk_id: "chunk-2", chunk_index: 1, text: "Second stored chunk" },
    );
    const ai = new FakeAi();
    const vectorize = new FakeVectorize();

    const result = await upsertStoredPageVectors(
      { NOTION_RAG_DB: db, AI: ai, NOTION_VECTORIZE: vectorize },
      "source-1",
      rootPageId,
    );

    expect(result).toEqual({ vectorCount: 2 });
    expect(ai.calls).toEqual([["First stored chunk", "Second stored chunk"]]);
    expect(vectorize.upserts).toHaveLength(1);
    expect(vectorize.upserts[0]?.map((vector) => vector.id)).toEqual(["chunk-1", "chunk-2"]);
  });

  test("does not re-embed or upsert an unchanged Notion page", async () => {
    const blocks: NotionBlock[] = [
      {
        id: "paragraph",
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: "Stable content" }] },
      },
    ];
    const db = new FakeD1();
    db.existingPageIndexRow = {
      content_hash: await sha256Hex(createNotionPageChunks("Root", blocks).join("\n\n")),
      embedding_model: "@cf/baai/bge-m3",
      is_deleted: 0,
    };
    const ai = new FakeAi();
    const vectorize = new FakeVectorize();

    const result = await persistNotionPageIndex(
      { NOTION_RAG_DB: db, AI: ai, NOTION_VECTORIZE: vectorize },
      "source-1",
      createPage(rootPageId, "Root"),
      blocks,
      "2026-08-05T00:00:00.000Z",
    );

    expect(result.chunkCount).toBe(0);
    expect(ai.calls).toEqual([]);
    expect(vectorize.upserts).toEqual([]);
    expect(db.vectorizeUsageByMonth.size).toBe(0);
    expect(
      db.runs.some(
        (run) =>
          run.query.includes("UPDATE notion_pages") && run.query.includes("last_edited_time = ?"),
      ),
    ).toBe(true);
  });

  test("re-embeds unchanged content when the embedding model changes", async () => {
    const blocks: NotionBlock[] = [
      {
        id: "paragraph",
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: "Stable content" }] },
      },
    ];
    const db = new FakeD1();
    db.existingPageIndexRow = {
      content_hash: await sha256Hex(createNotionPageChunks("Root", blocks).join("\n\n")),
      embedding_model: "@cf/legacy/model",
      is_deleted: 0,
    };
    const ai = new FakeAi();
    const vectorize = new FakeVectorize();

    const result = await persistNotionPageIndex(
      { NOTION_RAG_DB: db, AI: ai, NOTION_VECTORIZE: vectorize },
      "source-1",
      createPage(rootPageId, "Root"),
      blocks,
      "2026-08-05T00:00:00.000Z",
    );

    expect(result.chunkCount).toBe(1);
    expect(ai.calls).toHaveLength(1);
    expect(vectorize.upserts).toHaveLength(1);
  });

  test("does not re-embed or upsert an unchanged external document", async () => {
    const url = "https://docs.example.test/stable";
    const markdown = `Source URL: ${url}\n\nExternal documentation body.`;
    const db = new FakeD1();
    db.existingExternalIndexRow = {
      content_hash: await sha256Hex(
        createExternalMarkdownChunks("docs.example.test", markdown).join("\n\n"),
      ),
      embedding_model: "@cf/baai/bge-m3",
      page_is_deleted: 0,
    };
    const ai = new FakeAi();
    const vectorize = new FakeVectorize();

    const result = await indexExternalLinks({
      env: {
        NOTION_RAG_DB: db,
        AI: ai,
        NOTION_VECTORIZE: vectorize,
        BROWSER: {},
        NOTION_EXTERNAL_HOST_ALLOWLIST: "docs.example.test",
      },
      sourceId: "source-1",
      links: [{ parentPageId: rootPageId, url }],
      indexedAt: "2026-08-05T00:00:00.000Z",
    });

    expect(result).toEqual({ chunkCount: 0, externalLinkCount: 1 });
    expect(ai.calls).toEqual([]);
    expect(vectorize.upserts).toEqual([]);
    expect(db.vectorizeUsageByMonth.size).toBe(0);
  });

  test("re-embeds an external document when only its title changes", async () => {
    const url = "https://docs.example.test/title-change";
    const markdown = `Source URL: ${url}\n\nExternal documentation body.`;
    const db = new FakeD1();
    db.existingExternalIndexRow = {
      content_hash: await sha256Hex(
        createExternalMarkdownChunks("Previous title", markdown).join("\n\n"),
      ),
      embedding_model: "@cf/baai/bge-m3",
      page_is_deleted: 0,
    };
    const ai = new FakeAi();
    const vectorize = new FakeVectorize();

    const result = await indexExternalLinks({
      env: {
        NOTION_RAG_DB: db,
        AI: ai,
        NOTION_VECTORIZE: vectorize,
        BROWSER: {},
        NOTION_EXTERNAL_HOST_ALLOWLIST: "docs.example.test",
      },
      sourceId: "source-1",
      links: [{ parentPageId: rootPageId, url }],
      indexedAt: "2026-08-05T00:00:00.000Z",
    });

    expect(result.chunkCount).toBe(1);
    expect(ai.calls).toHaveLength(1);
    expect(vectorize.upserts).toHaveLength(1);
  });

  test("preserves an existing external index when the Vectorize budget is exhausted", async () => {
    const url = "https://docs.example.test/budget";
    const usageMonth = new Date().toISOString().slice(0, 7);
    const db = new FakeD1();
    db.storedChunks.push({
      chunk_id: "existing-external-chunk",
      chunk_index: 0,
      page_id: "x:existing",
      text: "Existing external content",
    });
    db.existingExternalIndexRow = {
      content_hash: "previous-content-hash",
      embedding_model: "@cf/baai/bge-m3",
      page_is_deleted: 0,
    };
    db.vectorizeUsageByMonth.set(usageMonth, 1024);
    const vectorize = new FakeVectorize();

    await expect(
      indexExternalLinks({
        env: {
          NOTION_RAG_DB: db,
          AI: new FakeAi(),
          NOTION_VECTORIZE: vectorize,
          NOTION_VECTORIZE_DIMENSIONS: "1024",
          NOTION_VECTORIZE_MONTHLY_UPSERT_DIMENSION_WARNING: "1024",
          NOTION_VECTORIZE_MONTHLY_UPSERT_DIMENSION_BUDGET: "1024",
          BROWSER: {},
          NOTION_EXTERNAL_HOST_ALLOWLIST: "docs.example.test",
        },
        sourceId: "source-1",
        links: [{ parentPageId: rootPageId, url }],
        indexedAt: "2026-08-05T00:00:00.000Z",
      }),
    ).rejects.toThrow("vectorize_monthly_upsert_budget_exceeded");

    expect(vectorize.deletedIds).toEqual([]);
    expect(
      db.runs.some((run) => run.query.includes("DELETE FROM notion_chunks WHERE source_id")),
    ).toBe(false);
    expect(
      db.runs.some(
        (run) => run.query.includes("UPDATE notion_pages") && run.query.includes("is_deleted = 1"),
      ),
    ).toBe(false);
  });

  test("atomically rejects Vectorize upserts beyond the monthly safety budget", async () => {
    const db = new FakeD1();
    const env: NotionRagMcpBindings = {
      NOTION_RAG_DB: db,
      NOTION_VECTORIZE_DIMENSIONS: "1024",
      NOTION_VECTORIZE_MONTHLY_UPSERT_DIMENSION_WARNING: "2048",
      NOTION_VECTORIZE_MONTHLY_UPSERT_DIMENSION_BUDGET: "2048",
    };
    const august = new Date("2026-08-05T00:00:00.000Z");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(reserveVectorizeUpsertBudget(env, 1, august)).resolves.toMatchObject({
      usedDimensions: 1024,
    });
    await expect(reserveVectorizeUpsertBudget(env, 1, august)).resolves.toMatchObject({
      usedDimensions: 2048,
    });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('"event":"vectorize_monthly_upsert_budget_warning"'),
    );
    await expect(reserveVectorizeUpsertBudget(env, 1, august)).rejects.toThrow(
      "vectorize_monthly_upsert_budget_exceeded:2026-08:1024:2048",
    );
    await expect(
      reserveVectorizeUpsertBudget(env, 1, new Date("2026-09-01T00:00:00.000Z")),
    ).resolves.toMatchObject({ usedDimensions: 1024 });
  });

  test("repairs a source from stored D1 chunks only when explicitly requested", async () => {
    const db = new FakeD1();
    db.storedChunks.push(
      {
        chunk_id: "repair-chunk-1",
        chunk_index: 0,
        page_id: rootPageId,
        text: "First repair chunk",
      },
      {
        chunk_id: "repair-chunk-2",
        chunk_index: 1,
        page_id: rootPageId,
        text: "Second repair chunk",
      },
    );
    const ai = new FakeAi();
    const vectorize = new FakeVectorize();
    const step = new FakeWorkflowStep();

    const result = await repairNotionSourceVectors(
      { NOTION_RAG_DB: db, AI: ai, NOTION_VECTORIZE: vectorize },
      "source-1",
      step,
    );

    expect(result).toEqual({
      sourceId: "source-1",
      repairedPageCount: 1,
      repairedVectorCount: 2,
    });
    expect(step.names).toEqual([
      "prepare notion vector repair",
      `repair notion vectors 1-${rootPageId}`,
    ]);
    expect(vectorize.upserts).toHaveLength(1);
  });

  test("marks deeply nested block traversal as truncated before the Worker request limit", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const blockId = decodeURIComponent(
        url.pathname.slice("/v1/blocks/".length, -"/children".length),
      );
      return Response.json({
        results:
          blockId === rootPageId
            ? Array.from({ length: 41 }, (_, index) => ({
                id: `nested-${index}`,
                type: "toggle",
                has_children: true,
                toggle: { rich_text: [] },
              }))
            : [],
        next_cursor: null,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createIndexingNotionClient({
      NOTION_API_TOKEN: "test-token",
    }).listPageBlocksWithStatus(rootPageId, 800);

    expect(result.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(40);
  });
});

async function handleNotionRequest(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.pathname === "/v1/search") {
    const body = JSON.parse(String(init?.body)) as {
      readonly filter?: { readonly value?: string };
    };
    return Response.json({
      results: body.filter?.value === "page" ? [createPage(secondPageId, "Second")] : [],
      next_cursor: null,
    });
  }
  if (url.pathname.startsWith("/v1/pages/")) {
    const pageId = decodeURIComponent(url.pathname.slice("/v1/pages/".length));
    return Response.json(createPage(pageId, pageId === rootPageId ? "Root" : "Second"));
  }
  if (url.pathname === `/v1/databases/${databaseId}`) {
    return Response.json({ id: databaseId, object: "database", data_sources: [] });
  }
  if (url.pathname === `/v1/databases/${databaseId}/query`) {
    return Response.json({ results: [createPage(secondPageId, "Second")], next_cursor: null });
  }
  if (url.pathname.startsWith("/v1/blocks/") && url.pathname.endsWith("/children")) {
    const blockId = decodeURIComponent(
      url.pathname.slice("/v1/blocks/".length, -"/children".length),
    );
    return Response.json({
      results:
        blockId === rootPageId
          ? [
              {
                id: "long-paragraph",
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "Runbook detail. ".repeat(7000) }] },
              },
              {
                id: secondPageId,
                type: "child_page",
                child_page: { title: "Second" },
              },
              {
                id: databaseId,
                type: "child_database",
                child_database: { title: "Pages" },
              },
              ...Array.from({ length: 6 }, (_, index) => ({
                id: `external-${index + 1}`,
                type: "bookmark",
                bookmark: { url: `https://docs.example.test/${index + 1}` },
              })),
            ]
          : blockId === secondPageId
            ? Array.from({ length: 45 }, (_, index) => ({
                id: `nested-${index + 1}`,
                type: "toggle",
                has_children: true,
                toggle: { rich_text: [{ plain_text: `Nested section ${index + 1}` }] },
              }))
            : [
                {
                  id: `${blockId}-paragraph`,
                  type: "paragraph",
                  paragraph: { rich_text: [{ plain_text: "Nested body." }] },
                },
              ],
      next_cursor: null,
    });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

async function handleExcludedPageNotionRequest(input: string | URL | Request) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.pathname.startsWith("/v1/pages/")) {
    const pageId = decodeURIComponent(url.pathname.slice("/v1/pages/".length));
    return Response.json(
      createPage(pageId, pageId === rootPageId ? "Root" : "Excluded", {
        excluded: pageId === secondPageId,
      }),
    );
  }
  if (url.pathname === `/v1/blocks/${rootPageId}/children`) {
    return Response.json({
      results: [
        {
          id: secondPageId,
          type: "child_page",
          child_page: { title: "Excluded" },
        },
      ],
      next_cursor: null,
    });
  }
  if (url.pathname === `/v1/blocks/${secondPageId}/children`) {
    throw new Error("excluded page blocks should not be requested");
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

function createPage(id: string, title: string, options: { readonly excluded?: boolean } = {}) {
  return {
    id,
    object: "page",
    url: `https://www.notion.so/${id.replaceAll("-", "")}`,
    last_edited_time: "2026-07-15T00:00:00.000Z",
    properties: {
      title: { type: "title", title: [{ plain_text: title }] },
      ...(options.excluded ? { wiki検索対象外: { type: "checkbox", checkbox: true } } : {}),
    },
  };
}

class FakeD1 implements CloudflareD1Database {
  readonly batches: FakeStatement[][] = [];
  readonly runs: FakeStatement[] = [];
  readonly activeJobBySource = new Map<string, string>();
  readonly workItems = new Map<string, FakeWorkItem>();
  readonly vectorizeUsageByMonth = new Map<string, number>();
  existingPageIndexRow: {
    readonly content_hash: string | null;
    readonly embedding_model: string | null;
    readonly is_deleted: number;
  } | null = null;
  existingExternalIndexRow: {
    readonly content_hash: string | null;
    readonly embedding_model: string | null;
    readonly page_is_deleted: number | null;
  } | null = null;
  readonly storedChunks: {
    readonly chunk_id: string;
    readonly chunk_index: number;
    readonly page_id?: string;
    readonly text: string;
  }[] = [];

  prepare(query: string) {
    return new FakeStatement(this, query);
  }

  async batch(statements: CloudflareD1PreparedStatement[]) {
    this.batches.push(statements as FakeStatement[]);
    return await Promise.all(statements.map(async (statement) => statement.run()));
  }
}

type FakeWorkItem = {
  readonly jobId: string;
  readonly itemId: string;
  readonly itemType: string;
  status: string;
  resultJson: string | null;
  stateJson: string | null;
  errorMessage: string | null;
};

class FakeStatement implements CloudflareD1PreparedStatement {
  private values: readonly unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    readonly query: string,
  ) {}

  bind(...values: readonly unknown[]) {
    this.values = values;
    return this;
  }

  async run() {
    this.db.runs.push(this);
    if (this.query.includes("INSERT OR IGNORE INTO notion_index_jobs")) {
      const jobId = String(this.values[0]);
      const sourceId = String(this.values[1]);
      if (!this.db.activeJobBySource.has(sourceId)) {
        this.db.activeJobBySource.set(sourceId, jobId);
      }
    } else if (this.query.includes("INSERT OR IGNORE INTO notion_index_work_items")) {
      const jobId = String(this.values[0]);
      const itemId = String(this.values[1]);
      const itemType = String(this.values[2]);
      const status = String(this.values[4]);
      const key = `${jobId}:${itemId}`;
      if (!this.db.workItems.has(key)) {
        this.db.workItems.set(key, {
          jobId,
          itemId,
          itemType,
          status,
          resultJson: null,
          stateJson: null,
          errorMessage: null,
        });
      }
    } else if (this.query.includes("UPDATE notion_index_work_items")) {
      this.updateWorkItem();
    }
    return {};
  }

  async all<T>() {
    if (this.query.includes("SELECT DISTINCT page_id")) {
      return {
        results: [...new Set(this.db.storedChunks.map((row) => row.page_id ?? rootPageId))].map(
          (page_id) => ({ page_id }),
        ) as T[],
      };
    }
    if (this.query.includes("SELECT chunk_id, chunk_index, text")) {
      return { results: this.db.storedChunks as T[] };
    }
    if (this.query.includes("SELECT chunk_id FROM notion_chunks")) {
      return { results: this.db.storedChunks.map(({ chunk_id }) => ({ chunk_id })) as T[] };
    }
    if (this.query.includes("result_json") && this.query.includes("notion_index_work_items")) {
      const [jobId, itemType] = this.values.map(String);
      return {
        results: [...this.db.workItems.values()]
          .filter(
            (item) =>
              item.jobId === jobId && item.itemType === itemType && item.status === "succeeded",
          )
          .sort((left, right) => left.itemId.localeCompare(right.itemId))
          .map((item) => ({ item_id: item.itemId, result_json: item.resultJson }) as T),
      };
    }
    return { results: [] as T[] };
  }

  async first<T>() {
    if (this.query.includes("INSERT INTO notion_vectorize_monthly_usage")) {
      const usageMonth = String(this.values[0]);
      const requestedDimensions = Number(this.values[1]);
      const budget = Number(this.values[3]);
      const usedDimensions = this.db.vectorizeUsageByMonth.get(usageMonth) ?? 0;
      const nextDimensions = usedDimensions + requestedDimensions;
      if (nextDimensions > budget) {
        return null;
      }
      this.db.vectorizeUsageByMonth.set(usageMonth, nextDimensions);
      return { upserted_dimensions: nextDimensions } as T;
    }
    if (this.query.includes("SELECT content_hash, embedding_model, is_deleted FROM notion_pages")) {
      return this.db.existingPageIndexRow as T | null;
    }
    if (this.query.includes("SELECT d.content_hash, p.embedding_model")) {
      return this.db.existingExternalIndexRow as T | null;
    }
    if (this.query.includes("SELECT job_id FROM notion_index_jobs")) {
      const jobId = this.db.activeJobBySource.get(String(this.values[0]));
      return jobId ? ({ job_id: jobId } as T) : null;
    }
    if (this.query.includes("SELECT id FROM notion_sources")) {
      return { id: "source-1" } as T;
    }
    if (
      this.query.includes("SELECT status, result_json, state_json") &&
      this.query.includes("notion_index_work_items")
    ) {
      const jobId = String(this.values[0]);
      const itemId = String(this.values[1]);
      const item = this.db.workItems.get(`${jobId}:${itemId}`);
      return item
        ? ({
            status: item.status,
            result_json: item.resultJson,
            state_json: item.stateJson,
          } as T)
        : null;
    }
    if (this.query.includes("COUNT(*) AS total_count")) {
      const [jobId, itemType] = this.values.map(String);
      const items = [...this.db.workItems.values()].filter(
        (item) => item.jobId === jobId && item.itemType === itemType,
      );
      return {
        total_count: items.length,
        pending_count: items.filter((item) => ["queued", "running"].includes(item.status)).length,
        failed_count: items.filter((item) => item.status === "failed").length,
      } as T;
    }
    if (this.query.includes("SELECT item_id, error_message")) {
      const [jobId, itemType] = this.values.map(String);
      const item = [...this.db.workItems.values()].find(
        (candidate) =>
          candidate.jobId === jobId &&
          candidate.itemType === itemType &&
          candidate.status === "failed",
      );
      return item ? ({ item_id: item.itemId, error_message: item.errorMessage } as T) : null;
    }
    if (this.query.includes("SELECT * FROM notion_sources")) {
      return {
        id: "source-1",
        org_id: "org-1",
        name: "Test source",
        root_page_id: rootPageId,
      } as T;
    }
    return null;
  }

  private updateWorkItem() {
    if (this.query.includes("state_json = ?")) {
      const stateJson = String(this.values[0]);
      const jobId = String(this.values[2]);
      const itemId = String(this.values[3]);
      const item = this.db.workItems.get(`${jobId}:${itemId}`);
      if (item) {
        item.status = "running";
        item.stateJson = stateJson;
      }
      return;
    }
    if (this.query.includes("status = 'running'")) {
      const [, jobId, itemId] = this.values.map(String);
      const item = this.db.workItems.get(`${jobId}:${itemId}`);
      if (item) {
        item.status = "running";
        item.errorMessage = null;
      }
      return;
    }
    if (this.query.includes("status = 'succeeded'")) {
      const resultJson = String(this.values[0]);
      const jobId = String(this.values[2]);
      const itemId = String(this.values[3]);
      const item = this.db.workItems.get(`${jobId}:${itemId}`);
      if (item) {
        item.status = "succeeded";
        item.resultJson = resultJson;
        item.stateJson = null;
        item.errorMessage = null;
      }
      return;
    }
    if (this.query.includes("status = 'failed'")) {
      const errorMessage = String(this.values[0]);
      const jobId = String(this.values[2]);
      const itemId = String(this.values[3]);
      const item = this.db.workItems.get(`${jobId}:${itemId}`);
      if (item) {
        item.status = "failed";
        item.errorMessage = errorMessage;
      }
    }
  }
}

class FakeAi {
  readonly calls: string[][] = [];

  async run(_model: string, input: Record<string, unknown>) {
    const texts = Array.isArray(input.text)
      ? input.text.filter((text) => typeof text === "string")
      : [];
    this.calls.push(texts);
    return { data: texts.map(() => [0.1, 0.2, 0.3]) };
  }
}

class FakeVectorize {
  readonly upserts: VectorizeVector[][] = [];
  readonly deletedIds: string[][] = [];

  async query() {
    return { matches: [] };
  }

  async upsert(vectors: readonly VectorizeVector[]) {
    this.upserts.push([...vectors]);
    return {};
  }

  async deleteByIds(ids: readonly string[]) {
    this.deletedIds.push([...ids]);
    return {};
  }
}

class FakeWorkflowStep {
  readonly names: string[] = [];
  readonly sleepNames: string[] = [];
  readonly sleepDurations: string[] = [];

  async do<T>(name: string, callback: () => Promise<T>) {
    this.names.push(name);
    return await callback();
  }

  async sleep(name: string, duration: string) {
    this.sleepNames.push(name);
    this.sleepDurations.push(duration);
  }
}

class FakeIndexWorkItemWorkflowBinding {
  readonly created: { readonly id: string; readonly params: NotionIndexWorkItemWorkflowPayload }[] =
    [];

  constructor(private readonly getEnv: () => NotionRagMcpBindings) {}

  async create(options?: { id?: string; params?: NotionIndexWorkItemWorkflowPayload }) {
    if (!options?.id || !options.params) {
      throw new Error("missing_work_item_options");
    }
    this.created.push({ id: options.id, params: options.params });
    await runNotionIndexWorkItemWorkflow({ env: this.getEnv(), payload: options.params });
    return new FakeWorkflowInstance(options.id);
  }

  async createBatch(
    options: readonly { id: string; params: NotionIndexWorkItemWorkflowPayload }[],
  ) {
    return await Promise.all(options.map(async (option) => this.create(option)));
  }

  async get(id: string) {
    return new FakeWorkflowInstance(id);
  }
}

class FakeWorkflowInstance {
  constructor(readonly id: string) {}

  async status() {
    return { status: "complete" };
  }
}
