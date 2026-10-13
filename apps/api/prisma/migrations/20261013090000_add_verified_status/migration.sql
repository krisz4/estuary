-- Data-only: `verified` is inserted into TASK_STATUSES at index 8, between
-- `needs_qa` and `done`, so the persisted statusRank (the index in that list)
-- shifts for the two statuses after it. No schema change. Keyed on `status`,
-- so it is safe to re-run. `verified` rows cannot exist yet.
UPDATE "Task" SET "statusRank" = 9 WHERE "status" = 'done';
UPDATE "Task" SET "statusRank" = 10 WHERE "status" = 'deferred';
