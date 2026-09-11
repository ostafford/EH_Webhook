-- Migration 0004: track each employee's last sync decision on employee_map
-- itself (issue #43), so the daily recheck pass can find every row stuck on a
-- Manual-follow-up without scanning sync_log.
--
-- Backfill from sync_log so employees already sitting on a stale follow-up
-- before this migration deploys are picked up by the very next recheck, not
-- only after their next profile edit.

ALTER TABLE employee_map ADD COLUMN last_outcome TEXT;

UPDATE employee_map
SET last_outcome = (
  SELECT outcome FROM sync_log
  WHERE sync_log.ct_user_id = employee_map.ct_user_id
  ORDER BY at DESC
  LIMIT 1
)
WHERE last_outcome IS NULL;
