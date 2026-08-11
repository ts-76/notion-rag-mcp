CREATE TABLE IF NOT EXISTS notion_vectorize_monthly_usage (
  usage_month TEXT PRIMARY KEY,
  upserted_dimensions INTEGER NOT NULL CHECK (upserted_dimensions >= 0),
  updated_at TEXT NOT NULL
);

-- Start conservatively: treat every index job started in the current month as a
-- full insertion of the currently stored vectors. This intentionally overcounts
-- partial, failed, and audit jobs while estimating known job-triggered usage.
INSERT INTO notion_vectorize_monthly_usage (
  usage_month,
  upserted_dimensions,
  updated_at
)
SELECT
  strftime('%Y-%m', 'now'),
  stored.vector_count * 1024 * MAX(jobs.job_count, 1),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM
  (SELECT COUNT(*) AS vector_count FROM notion_chunks) AS stored,
  (
    SELECT COUNT(*) AS job_count
    FROM notion_index_jobs
    WHERE started_at >= strftime('%Y-%m-01T00:00:00.000Z', 'now')
  ) AS jobs
WHERE stored.vector_count > 0
ON CONFLICT(usage_month) DO NOTHING;
