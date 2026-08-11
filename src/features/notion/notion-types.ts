export type NotionPage = {
  readonly id: string;
  readonly object?: string;
  readonly url?: string;
  readonly last_edited_time?: string;
  readonly parent?: unknown;
  readonly properties?: Record<string, unknown>;
};

export type NotionDatabase = {
  readonly id: string;
  readonly object?: string;
  readonly data_sources?: readonly unknown[];
  readonly title?: readonly unknown[];
};

export type NotionBlock = {
  readonly id: string;
  readonly type?: string;
  readonly has_children?: boolean;
  readonly child_page?: { readonly title?: string };
  readonly child_database?: { readonly title?: string };
  readonly [key: string]: unknown;
};
