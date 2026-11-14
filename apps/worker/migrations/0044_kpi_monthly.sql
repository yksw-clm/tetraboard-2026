CREATE TABLE kpi_monthly (
  month TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  computed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (month, metric)
);
