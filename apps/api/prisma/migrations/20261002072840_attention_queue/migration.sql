-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "acceptanceCriteria" TEXT,
    "status" TEXT NOT NULL DEFAULT 'backlog',
    "statusRank" INTEGER NOT NULL DEFAULT 0,
    "statusNote" TEXT,
    "concerns" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "priorityRank" INTEGER NOT NULL DEFAULT 1,
    "project" TEXT,
    "assignee" TEXT,
    "createdBy" TEXT NOT NULL,
    "needsTriage" BOOLEAN NOT NULL DEFAULT false,
    "links" TEXT NOT NULL DEFAULT '[]',
    "claimedBy" TEXT,
    "claimExpiresAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT,
    "parentId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "Task_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("acceptanceCriteria", "assignee", "claimExpiresAt", "claimedBy", "completedAt", "createdAt", "createdBy", "description", "id", "idempotencyKey", "links", "parentId", "priority", "priorityRank", "project", "startedAt", "status", "statusNote", "statusRank", "title", "updatedAt", "version") SELECT "acceptanceCriteria", "assignee", "claimExpiresAt", "claimedBy", "completedAt", "createdAt", "createdBy", "description", "id", "idempotencyKey", "links", "parentId", "priority", "priorityRank", "project", "startedAt", "status", "statusNote", "statusRank", "title", "updatedAt", "version" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE UNIQUE INDEX "Task_idempotencyKey_key" ON "Task"("idempotencyKey");
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");
CREATE INDEX "Task_statusRank_idx" ON "Task"("statusRank");
CREATE INDEX "Task_priorityRank_idx" ON "Task"("priorityRank");
CREATE INDEX "Task_statusRank_createdAt_idx" ON "Task"("statusRank", "createdAt");
CREATE INDEX "Task_status_priorityRank_createdAt_idx" ON "Task"("status", "priorityRank", "createdAt");
CREATE INDEX "Task_project_idx" ON "Task"("project");
CREATE INDEX "Task_assignee_idx" ON "Task"("assignee");
CREATE INDEX "Task_createdBy_idx" ON "Task"("createdBy");
CREATE INDEX "Task_parentId_idx" ON "Task"("parentId");
CREATE INDEX "Task_needsTriage_status_idx" ON "Task"("needsTriage", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
