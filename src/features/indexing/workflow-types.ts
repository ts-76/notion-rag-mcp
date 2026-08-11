import type { createIndexingNotionClient } from "../notion/client";
import type { ExternalLinkToIndex } from "./external-documents";

export type NotionSourceRow = {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly root_page_id: string;
  readonly last_indexed_at?: string | null;
};

export type PageToIndexRef = {
  readonly pageId: string;
};

export type NotionPageDiscoveryResult = {
  readonly pageId: string;
  readonly childPageIds: readonly string[];
  readonly databaseIds: readonly string[];
  readonly truncated: boolean;
};

export type NotionPageIndexResult = {
  readonly pageId: string;
  readonly pageCount: number;
  readonly chunkCount: number;
  readonly externalUrls: readonly string[];
};

export type NotionWorkflowStepRequest =
  | { readonly type: "discover-page"; readonly pageId: string }
  | { readonly type: "discover-database"; readonly databaseId: string; readonly limit: number }
  | {
      readonly type: "index-page";
      readonly sourceId: string;
      readonly pageId: string;
      readonly indexedAt: string;
    }
  | {
      readonly type: "index-external-links";
      readonly sourceId: string;
      readonly links: readonly ExternalLinkToIndex[];
      readonly indexedAt: string;
    };

export type NotionIndexDiscoveryClient = Pick<
  ReturnType<typeof createIndexingNotionClient>,
  "listPageBlocks" | "queryDatabasePages" | "retrieveDatabase" | "retrievePage"
> & {
  readonly listPageBlocksWithStatus?: ReturnType<
    typeof createIndexingNotionClient
  >["listPageBlocksWithStatus"];
};

export type PageIndexResult = {
  readonly kind: "page";
  readonly pageCount: number;
  readonly pageId: string;
  readonly chunkCount: number;
  readonly externalUrls: readonly string[];
  readonly childPageIds: readonly string[];
  readonly databaseIds: readonly string[];
  readonly discoveryComplete: boolean;
};

export type DatabaseDiscoveryResult = {
  readonly kind: "database";
  readonly pageIds: readonly string[];
};

export type PageWorkItemResult = PageIndexResult | DatabaseDiscoveryResult;

export type ExternalIndexResult = {
  readonly chunkCount: number;
  readonly externalLinkCount: number;
};

export type ReindexWorkflowStep = {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
};

export const immediateWorkflowStep: ReindexWorkflowStep = {
  async do(_name, callback) {
    return await callback();
  },
  async sleep() {},
};
