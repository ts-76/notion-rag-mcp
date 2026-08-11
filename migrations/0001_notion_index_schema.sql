CREATE TABLE IF NOT EXISTS notion_sources (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  root_page_id TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_indexed_at TEXT
);

CREATE TABLE IF NOT EXISTS notion_pages (
  source_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  parent_page_id TEXT,
  last_edited_time TEXT,
  content_hash TEXT,
  indexed_at TEXT,
  last_seen_at TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, page_id)
);

CREATE TABLE IF NOT EXISTS notion_chunks (
  chunk_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  token_count INTEGER,
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notion_source_permissions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  role TEXT,
  permission TEXT,
  user_id TEXT
);

CREATE TABLE IF NOT EXISTS notion_index_jobs (
  job_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_by_user_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS notion_external_documents (
  document_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  parent_page_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  error_message TEXT,
  UNIQUE(source_id, url)
);

CREATE INDEX IF NOT EXISTS idx_notion_sources_org
  ON notion_sources(org_id, is_enabled);

CREATE INDEX IF NOT EXISTS idx_notion_pages_source
  ON notion_pages(source_id, is_deleted, indexed_at);

CREATE INDEX IF NOT EXISTS idx_notion_chunks_page
  ON notion_chunks(page_id, source_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_notion_source_permissions_lookup
  ON notion_source_permissions(org_id, source_id);

CREATE INDEX IF NOT EXISTS idx_notion_external_documents_source
  ON notion_external_documents(source_id, status, fetched_at);
