-- Migration 0002: idempotency guard for the queue consumer.
-- Stores a hash of the last mapped payload we synced cleanly, so replaying an
-- unchanged edit is a no-op. NULL after any non-clean outcome (see src/sync/consumer.ts).

ALTER TABLE employee_map ADD COLUMN last_payload_hash TEXT;
