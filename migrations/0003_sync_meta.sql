-- Migration 0003: a tiny key/value table for operational counters and markers
-- that /health reports (queue backlog, dead-letter count, last successful sweep).
-- Identifiers and counts only - no employee values, same rule as every other table.

CREATE TABLE sync_meta (
  key        TEXT PRIMARY KEY,
  num        INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
