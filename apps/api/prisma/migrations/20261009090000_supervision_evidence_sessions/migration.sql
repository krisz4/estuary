ALTER TABLE "Task" ADD COLUMN "verification" TEXT;
ALTER TABLE "Task" ADD COLUMN "checkpoint" TEXT;
ALTER TABLE "Task" ADD COLUMN "attentionSince" DATETIME;
ALTER TABLE "Task" ADD COLUMN "snoozedUntil" DATETIME;
ALTER TABLE "Task" ADD COLUMN "claimSessionId" TEXT;
UPDATE "Task" SET "attentionSince" = COALESCE((SELECT MAX("createdAt") FROM "TaskEvent" WHERE "taskId" = "Task"."id" AND "type" = 'task.status_changed'), "createdAt")
WHERE "status" IN ('needs_user_decision','needs_user_action','needs_qa','needs_refinement')
OR ("status" IN ('backlog','todo') AND "needsTriage" = 1)
OR ("status" = 'blocked' AND NOT EXISTS (SELECT 1 FROM "TaskDependency" d JOIN "Task" t ON t."id" = d."dependsOnId" WHERE d."taskId" = "Task"."id" AND t."status" <> 'done'));
CREATE INDEX "Task_attentionSince_idx" ON "Task"("attentionSince");
ALTER TABLE "Task" ADD COLUMN "unlocksCount" INTEGER NOT NULL DEFAULT 0;
UPDATE "Task" SET "unlocksCount" = CASE WHEN "status" = 'done' THEN 0 ELSE (SELECT COUNT(*) FROM "TaskDependency" d JOIN "Task" target ON target."id" = d."taskId" WHERE d."dependsOnId" = "Task"."id" AND target."status" IN ('todo', 'blocked') AND NOT EXISTS (SELECT 1 FROM "TaskDependency" other JOIN "Task" blocker ON blocker."id" = other."dependsOnId" WHERE other."taskId" = target."id" AND other."dependsOnId" <> "Task"."id" AND blocker."status" <> 'done')) END;
CREATE INDEX "Task_unlocksCount_idx" ON "Task"("unlocksCount");
