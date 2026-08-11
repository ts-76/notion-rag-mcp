CREATE VIRTUAL TABLE IF NOT EXISTS notion_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  page_id UNINDEXED,
  source_id UNINDEXED,
  title,
  text
);
