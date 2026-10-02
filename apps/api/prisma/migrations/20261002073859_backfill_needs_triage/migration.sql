-- Flag the agent-filed work that predates `needsTriage`: tasks an agent created
-- that nobody ever started and that no person has touched since (no event by a
-- `human:` actor). The same rule the server applies to new tasks, run once over
-- the existing rows so suggestions filed before this change surface too.
UPDATE "Task"
SET "needsTriage" = true
WHERE "createdBy" LIKE 'agent:%'
  AND "startedAt" IS NULL
  AND "status" IN ('backlog', 'todo')
  AND NOT EXISTS (
    SELECT 1 FROM "TaskEvent" e
    WHERE e."taskId" = "Task"."id" AND e."actor" LIKE 'human:%'
  );
