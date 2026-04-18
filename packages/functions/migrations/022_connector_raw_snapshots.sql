CREATE TABLE IF NOT EXISTS connector_raw_snapshots (
  id            bigserial PRIMARY KEY,
  job_id        bigint NOT NULL REFERENCES ingestion_job(job_id) ON DELETE CASCADE,
  source        text NOT NULL,
  page          int NOT NULL DEFAULT 1,
  blob_path     text NOT NULL,
  record_count  int NOT NULL DEFAULT 0,
  captured_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_connector_raw_snapshots_job_id
  ON connector_raw_snapshots(job_id);

CREATE INDEX IF NOT EXISTS idx_connector_raw_snapshots_source
  ON connector_raw_snapshots(source);
