CREATE TABLE IF NOT EXISTS notion_index_work_items (
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('page', 'external')),
  source_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  payload_json TEXT NOT NULL,
  result_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_notion_index_work_items_status
  ON notion_index_work_items(job_id, item_type, status, item_id);
