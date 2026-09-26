-- AlterTable
ALTER TABLE "TaskEvent" ADD COLUMN "project" TEXT;

-- CreateTable
CREATE TABLE "TaskLabel" (
    "taskId" INTEGER NOT NULL,
    "label" TEXT NOT NULL,

    PRIMARY KEY ("taskId", "label"),
    CONSTRAINT "TaskLabel_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TaskLabel_label_idx" ON "TaskLabel"("label");

-- CreateIndex
CREATE INDEX "TaskEvent_project_id_idx" ON "TaskEvent"("project", "id");

-- Backfill: existing events did not carry a project, but the task they refer
-- to still does (or did, before any later delete) at migration time. taskId is
-- deliberately not a foreign key (note 5 in schema.prisma), so this is a plain
-- correlated subquery, not a join the schema could express.
UPDATE "TaskEvent"
SET "project" = (SELECT "project" FROM "Task" WHERE "Task"."id" = "TaskEvent"."taskId");
