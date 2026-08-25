export interface NotionRagMcpBindings {
  readonly NOTION_RAG_DB?: CloudflareD1Database;
  readonly NOTION_VECTORIZE?: VectorizeIndex;
  readonly AI?: WorkersAiBinding;
  readonly NOTION_API_TOKEN?: string;
  readonly NOTION_API_VERSION?: string;
  readonly NOTION_EMBEDDING_MODEL?: string;
  readonly NOTION_VECTORIZE_DIMENSIONS?: string;
  readonly NOTION_VECTORIZE_MONTHLY_UPSERT_DIMENSION_WARNING?: string;
  readonly NOTION_VECTORIZE_MONTHLY_UPSERT_DIMENSION_BUDGET?: string;
  readonly NOTION_EXTERNAL_HOST_ALLOWLIST?: string;
  readonly OAUTH_KV?: OAuthKvNamespace;
  readonly ACCESS_CLIENT_ID?: string;
  readonly ACCESS_CLIENT_SECRET?: string;
  readonly ACCESS_TOKEN_URL?: string;
  readonly ACCESS_AUTHORIZATION_URL?: string;
  readonly ACCESS_JWKS_URL?: string;
  readonly COOKIE_ENCRYPTION_KEY?: string;
  readonly NOTION_REINDEX_WORKFLOW?: WorkflowBinding<NotionReindexWorkflowPayload>;
  readonly NOTION_INDEX_SERVICE?: ServiceFetcher;
  readonly NOTION_INDEX_WORK_ITEM_WORKFLOW?: WorkflowBinding<NotionIndexWorkItemWorkflowPayload>;
  readonly BROWSER?: BrowserBinding;
}

export type NotionReindexWorkflowPayload = {
  readonly jobId: string;
  readonly sourceId: string;
  readonly actorUserId: string;
  readonly orgId: string;
  readonly mode?: "reindex" | "audit" | "repair" | "scheduled-reindex";
};

export type NotionIndexWorkItemWorkflowPayload = {
  readonly jobId: string;
  readonly itemId: string;
  readonly itemType: "page" | "external";
  readonly sourceId: string;
  readonly indexedAt: string;
  readonly pageId?: string;
  readonly databaseId?: string;
  readonly links?: readonly {
    readonly parentPageId: string;
    readonly url: string;
  }[];
  readonly part?: number;
  readonly startDelaySeconds?: number;
};

export type BrowserBinding = unknown;

export interface OAuthKvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ServiceFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface CloudflareD1Database {
  prepare(query: string): CloudflareD1PreparedStatement;
  batch(statements: CloudflareD1PreparedStatement[]): Promise<unknown[]>;
}

export interface CloudflareD1PreparedStatement {
  bind(...values: readonly unknown[]): CloudflareD1PreparedStatement;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
}

export interface VectorizeIndex {
  query(
    vector: readonly number[],
    options?: {
      topK?: number;
      returnMetadata?: "all" | "indexed" | "none" | boolean;
      filter?: Record<string, unknown>;
    },
  ): Promise<{ matches: VectorizeMatch[] }>;
  upsert(vectors: readonly VectorizeVector[]): Promise<unknown>;
  deleteByIds(ids: readonly string[]): Promise<unknown>;
}

export type VectorizeVector = {
  readonly id: string;
  readonly values: readonly number[];
  readonly metadata?: Record<string, string | number | boolean | string[]>;
};

export type VectorizeMatch = {
  readonly id: string;
  readonly score: number;
  readonly metadata?: Record<string, unknown>;
};

export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface WorkflowBinding<Payload> {
  create(options?: { id?: string; params?: Payload }): Promise<WorkflowInstance>;
  createBatch(options: readonly { id: string; params: Payload }[]): Promise<WorkflowInstance[]>;
  get(id: string): Promise<WorkflowInstance>;
}

export interface WorkflowInstance {
  readonly id: string;
  status(): Promise<unknown>;
}
