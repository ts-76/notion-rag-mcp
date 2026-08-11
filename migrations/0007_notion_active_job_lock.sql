CREATE UNIQUE INDEX IF NOT EXISTS idx_notion_index_jobs_active_source
  ON notion_index_jobs(source_id)
  WHERE status IN ('queued', 'running');
