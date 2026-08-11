CREATE TABLE notion_pages_source_scoped (
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

INSERT INTO notion_pages_source_scoped
  (source_id, page_id, title, url, parent_page_id, last_edited_time, content_hash, indexed_at, last_seen_at, is_deleted)
SELECT
  source_id, page_id, title, url, parent_page_id, last_edited_time, content_hash, indexed_at, last_seen_at, is_deleted
FROM notion_pages;

DROP TABLE notion_pages;
ALTER TABLE notion_pages_source_scoped RENAME TO notion_pages;

CREATE INDEX idx_notion_pages_source
  ON notion_pages(source_id, is_deleted, indexed_at);
