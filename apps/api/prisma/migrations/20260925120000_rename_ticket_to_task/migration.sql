-- Ticket → Task rename. Pure rename: no column changes, no data changes.
-- SQLite's RENAME TABLE / RENAME COLUMN rewrite the Comment foreign key in place;
-- indexes keep their old names, so they are dropped and recreated under Prisma's
-- naming convention to keep `migrate diff` clean.

ALTER TABLE "Ticket" RENAME TO "Task";
ALTER TABLE "Comment" RENAME COLUMN "ticketId" TO "taskId";

DROP INDEX "Ticket_createdAt_idx";
DROP INDEX "Ticket_statusRank_idx";
DROP INDEX "Ticket_priorityRank_idx";
DROP INDEX "Ticket_statusRank_createdAt_idx";
DROP INDEX "Ticket_requesterEmail_idx";
DROP INDEX "Ticket_category_idx";
DROP INDEX "Ticket_assignee_idx";
DROP INDEX "Comment_ticketId_id_idx";

CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");
CREATE INDEX "Task_statusRank_idx" ON "Task"("statusRank");
CREATE INDEX "Task_priorityRank_idx" ON "Task"("priorityRank");
CREATE INDEX "Task_statusRank_createdAt_idx" ON "Task"("statusRank", "createdAt");
CREATE INDEX "Task_requesterEmail_idx" ON "Task"("requesterEmail");
CREATE INDEX "Task_category_idx" ON "Task"("category");
CREATE INDEX "Task_assignee_idx" ON "Task"("assignee");
CREATE INDEX "Comment_taskId_id_idx" ON "Comment"("taskId", "id");
