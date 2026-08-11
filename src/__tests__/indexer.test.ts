import { describe, expect, test } from "vitest";
import {
  createExternalMarkdownChunks,
  createNotionPageChunks,
  discoverNotionPageRefs,
  extractChildDatabaseIds,
  extractChildPageIds,
  extractExternalUrlsFromBlocks,
  isIndexableExternalUrl,
  isNotionPageExcludedFromSearch,
  notionSearchExclusionPropertyName,
  type NotionBlock,
} from "../features/indexing/indexer";
import { extractNotionSearchProperties } from "../features/notion/page-properties";

describe("Notion indexer chunking", () => {
  test("keeps page and heading context on split chunks", () => {
    const blocks: NotionBlock[] = [
      {
        id: "heading",
        type: "heading_1",
        heading_1: { rich_text: [{ plain_text: "Deployment" }] },
      },
      {
        id: "paragraph",
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: "Release step. ".repeat(200) }] },
      },
    ];

    const chunks = createNotionPageChunks("Operations Runbook", blocks);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith("Page: Operations Runbook"))).toBe(true);
    expect(chunks.every((chunk) => chunk.includes("Section: Deployment"))).toBe(true);
    expect(chunks[0]).toContain("# Deployment");
  });

  test("formats list and to-do blocks for keyword search", () => {
    const blocks: NotionBlock[] = [
      {
        id: "list",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ plain_text: "Check WorkOS callback URLs" }] },
      },
      {
        id: "todo",
        type: "to_do",
        to_do: { checked: true, rich_text: [{ plain_text: "Reindex Notion pages" }] },
      },
    ];

    const [chunk] = createNotionPageChunks("Auth Notes", blocks);

    expect(chunk).toContain("- Check WorkOS callback URLs");
    expect(chunk).toContain("[x] Reindex Notion pages");
  });

  test("includes readable database properties without indexing control fields", () => {
    const properties = extractNotionSearchProperties({
      id: "chat-page",
      properties: {
        名前: { type: "title", title: [{ plain_text: "相談チャット" }] },
        Chatwork概要欄: {
          type: "rich_text",
          rich_text: [{ plain_text: "経理について相談するチャットです" }],
        },
        API検索用キーワード: {
          type: "multi_select",
          multi_select: [{ name: "経理" }, { name: "相談" }],
        },
        チーム名: { type: "select", select: { name: "管理部" } },
        責任者: { type: "people", people: [{ name: "山田さん" }] },
        room_id: { type: "number", number: 123456789 },
        Chatworkリンク: { type: "url", url: "https://www.chatwork.com/#!rid123456789" },
        公開中: { type: "checkbox", checkbox: true },
        関連ページ: { type: "relation", relation: [{ id: "related-page" }] },
        [notionSearchExclusionPropertyName]: { type: "checkbox", checkbox: false },
      },
    });

    const chunks = createNotionPageChunks("相談チャット", [], properties);
    const indexedText = chunks.join("\n");

    expect(indexedText).toContain("Section: Notion properties");
    expect(indexedText).toContain("Chatwork概要欄: 経理について相談するチャットです");
    expect(indexedText).toContain("API検索用キーワード: 経理, 相談");
    expect(indexedText).toContain("チーム名: 管理部");
    expect(indexedText).toContain("責任者: 山田さん");
    expect(indexedText).toContain("room_id: 123456789");
    expect(indexedText).toContain("Chatworkリンク: https://www.chatwork.com/#!rid123456789");
    expect(indexedText).toContain("公開中: true");
    expect(indexedText).not.toContain("名前:");
    expect(indexedText).not.toContain("関連ページ:");
    expect(indexedText).not.toContain(notionSearchExclusionPropertyName);
  });

  test("formats rich Notion block types for semantic indexing", () => {
    const blocks: NotionBlock[] = [
      {
        id: "callout",
        type: "callout",
        callout: {
          icon: { type: "emoji", emoji: "!" },
          rich_text: [{ plain_text: "Confirm production OAuth settings" }],
        },
      },
      {
        id: "code",
        type: "code",
        code: {
          language: "bash",
          rich_text: [{ plain_text: "wrangler vectorize info ai-toolkit-notion" }],
          caption: [{ plain_text: "Vectorize health check" }],
        },
      },
      {
        id: "table",
        type: "table_row",
        table_row: {
          cells: [[{ plain_text: "Query" }], [{ plain_text: "Expected page" }]],
        },
      },
      {
        id: "bookmark",
        type: "bookmark",
        bookmark: {
          url: "https://developers.cloudflare.com/vectorize/",
          caption: [{ plain_text: "Vectorize docs" }],
        },
      },
      {
        id: "equation",
        type: "equation",
        equation: { expression: "score = vector + keyword" },
      },
    ];

    const [chunk] = createNotionPageChunks("Search Notes", blocks);

    expect(chunk).toContain("Callout !: Confirm production OAuth settings");
    expect(chunk).toContain("Code (bash):");
    expect(chunk).toContain("Caption: Vectorize health check");
    expect(chunk).toContain("Table row: Query | Expected page");
    expect(chunk).toContain("Bookmark: Caption: Vectorize docs");
    expect(chunk).toContain("URL: https://developers.cloudflare.com/vectorize/");
    expect(chunk).toContain("Equation: score = vector + keyword");
  });

  test("extracts child database ids and preserves database context", () => {
    const blocks: NotionBlock[] = [
      {
        id: "14ee425662d8835e8314817ff0fb8707",
        type: "child_database",
        child_database: { title: "運営情報DB" },
      },
    ];

    const [chunk] = createNotionPageChunks("Wiki", blocks);

    expect(extractChildDatabaseIds(blocks)).toEqual(["14ee4256-62d8-835e-8314-817ff0fb8707"]);
    expect(chunk).toContain("Child database: 運営情報DB");
  });

  test("discovers only pages reachable from the configured root", async () => {
    const rootId = "11111111111111111111111111111111";
    const childId = "22222222222222222222222222222222";
    const databaseId = "33333333333333333333333333333333";
    const databasePageId = "44444444444444444444444444444444";
    const grandchildId = "55555555555555555555555555555555";
    const retrievedPageIds: string[] = [];
    const blocksByPageId = new Map<string, NotionBlock[]>([
      [
        "11111111-1111-1111-1111-111111111111",
        [
          { id: childId, type: "child_page", child_page: { title: "Child" } },
          { id: databaseId, type: "child_database", child_database: { title: "Database" } },
        ],
      ],
      [
        "22222222-2222-2222-2222-222222222222",
        [{ id: grandchildId, type: "child_page", child_page: { title: "Grandchild" } }],
      ],
    ]);
    const client = {
      async retrievePage(pageId: string) {
        retrievedPageIds.push(pageId);
        return { id: pageId };
      },
      async listPageBlocks(pageId: string) {
        return blocksByPageId.get(pageId) ?? [];
      },
      async retrieveDatabase(id: string) {
        expect(id).toBe("33333333-3333-3333-3333-333333333333");
        return { id, data_sources: [] };
      },
      async queryDatabasePages() {
        return [{ id: databasePageId }];
      },
    };

    const pageRefs = await discoverNotionPageRefs(client, rootId);

    expect(pageRefs).toEqual([
      { pageId: "11111111-1111-1111-1111-111111111111" },
      { pageId: "22222222-2222-2222-2222-222222222222" },
      { pageId: "44444444-4444-4444-4444-444444444444" },
      { pageId: "55555555-5555-5555-5555-555555555555" },
    ]);
    expect(retrievedPageIds).not.toContain("66666666-6666-6666-6666-666666666666");
  });

  test("recognizes only the checked wiki search exclusion property", () => {
    expect(
      isNotionPageExcludedFromSearch({
        id: "excluded",
        properties: {
          [notionSearchExclusionPropertyName]: { type: "checkbox", checkbox: true },
        },
      }),
    ).toBe(true);
    expect(
      isNotionPageExcludedFromSearch({
        id: "included",
        properties: {
          [notionSearchExclusionPropertyName]: { type: "checkbox", checkbox: false },
        },
      }),
    ).toBe(false);
    expect(
      isNotionPageExcludedFromSearch({
        id: "wrong-type",
        properties: {
          [notionSearchExclusionPropertyName]: { type: "rich_text", checkbox: true },
        },
      }),
    ).toBe(false);
    expect(isNotionPageExcludedFromSearch({ id: "missing" })).toBe(false);
  });

  test("does not discover excluded pages or their descendants", async () => {
    const rootId = "11111111111111111111111111111111";
    const excludedId = "22222222222222222222222222222222";
    const excludedChildId = "33333333333333333333333333333333";
    const listedPageIds: string[] = [];
    const client = {
      async retrievePage(pageId: string) {
        return pageId === "22222222-2222-2222-2222-222222222222"
          ? {
              id: pageId,
              properties: {
                [notionSearchExclusionPropertyName]: { type: "checkbox", checkbox: true },
              },
            }
          : { id: pageId };
      },
      async listPageBlocks(pageId: string) {
        listedPageIds.push(pageId);
        return pageId === "11111111-1111-1111-1111-111111111111"
          ? [{ id: excludedId, type: "child_page", child_page: { title: "Excluded" } }]
          : [
              {
                id: excludedChildId,
                type: "child_page",
                child_page: { title: "Excluded child" },
              },
            ];
      },
      async retrieveDatabase() {
        throw new Error("database discovery should not run");
      },
      async queryDatabasePages() {
        throw new Error("database query should not run");
      },
    };

    await expect(discoverNotionPageRefs(client, rootId)).resolves.toEqual([
      { pageId: "11111111-1111-1111-1111-111111111111" },
    ]);
    expect(listedPageIds).toEqual(["11111111-1111-1111-1111-111111111111"]);
  });

  test("skips child databases that are not accessible to the Notion integration", async () => {
    const rootId = "11111111111111111111111111111111";
    const inaccessibleDatabaseId = "33333333333333333333333333333333";
    const client = {
      async retrievePage(pageId: string) {
        return { id: pageId };
      },
      async listPageBlocks() {
        return [
          {
            id: inaccessibleDatabaseId,
            type: "child_database",
            child_database: { title: "Private Database" },
          },
        ] as NotionBlock[];
      },
      async retrieveDatabase() {
        throw new Error(
          "notion_api_failed:400:/databases/private:Database with ID private does not contain any data sources accessible by this API bot.",
        );
      },
      async queryDatabasePages() {
        throw new Error("query should not run");
      },
    };

    await expect(discoverNotionPageRefs(client, rootId)).resolves.toEqual([
      { pageId: "11111111-1111-1111-1111-111111111111" },
    ]);
  });

  test("extracts child page ids", () => {
    expect(
      extractChildPageIds([
        {
          id: "22222222222222222222222222222222",
          type: "child_page",
          child_page: { title: "Child" },
        },
      ]),
    ).toEqual(["22222222-2222-2222-2222-222222222222"]);
  });

  test("extracts only indexable external URLs from Notion blocks", () => {
    const blocks: NotionBlock[] = [
      {
        id: "bookmark",
        type: "bookmark",
        bookmark: { url: "https://example.com/docs" },
      },
      {
        id: "paragraph",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              plain_text: "internal",
              href: "http://localhost:8787/admin",
              text: { link: { url: "https://docs.example.test/page" } },
            },
          ],
        },
      },
    ];

    expect(extractExternalUrlsFromBlocks(blocks)).toEqual([
      "https://example.com/docs",
      "https://docs.example.test/page",
    ]);
    expect(isIndexableExternalUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isIndexableExternalUrl("https://192.168.0.10/private")).toBe(false);
    expect(isIndexableExternalUrl("http://[::1]/private")).toBe(false);
    expect(isIndexableExternalUrl("http://[::ffff:127.0.0.1]/private")).toBe(false);
  });

  test("chunks external markdown with page context", () => {
    const [chunk] = createExternalMarkdownChunks("External Docs", "# Setup\n\nRun weekly index.");

    expect(chunk).toContain("Page: External Docs");
    expect(chunk).toContain("Run weekly index.");
  });
});
