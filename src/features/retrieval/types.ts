export type NotionSourceRow = {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly root_page_id: string;
};

export type NotionPageRow = {
  readonly page_id: string;
  readonly source_id: string;
  readonly title: string;
  readonly url: string | null;
  readonly last_edited_time: string | null;
  readonly indexed_at: string | null;
};

export type NotionChunkRow = {
  readonly chunk_id: string;
  readonly page_id: string;
  readonly source_id: string;
  readonly chunk_index: number;
  readonly text: string;
};

export type IndexedNotionSearchResult = {
  readonly chunkId: string;
  readonly pageId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly url: string;
  readonly text: string;
  readonly score: number;
  readonly lastEditedTime: string;
  readonly indexedAt: string;
};

export type NotionPage = {
  readonly id: string;
  readonly object?: string;
  readonly url?: string;
  readonly last_edited_time?: string;
  readonly parent?: unknown;
  readonly properties?: Record<string, unknown>;
};
