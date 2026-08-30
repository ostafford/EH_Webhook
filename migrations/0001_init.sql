-- Migration 0001: initial schema.
-- Identifiers, sync bookkeeping and audit only. No employee values.

CREATE TABLE employee_map (
  ct_user_id          INTEGER PRIMARY KEY,
  eh_employee_id      TEXT,
  last_synced_ts      INTEGER,
  failure_cycle_count INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE onboarding_state (
  assignment_id       INTEGER PRIMARY KEY,
  ct_user_id          INTEGER NOT NULL,
  status              TEXT NOT NULL,
  is_waiting_approval INTEGER NOT NULL DEFAULT 0,
  seen_at             INTEGER NOT NULL
);
CREATE INDEX idx_onboarding_state_user ON onboarding_state (ct_user_id);

CREATE TABLE sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ct_user_id  INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  outcome     TEXT NOT NULL,
  detail      TEXT
);
CREATE INDEX idx_sync_log_user_at ON sync_log (ct_user_id, at);
