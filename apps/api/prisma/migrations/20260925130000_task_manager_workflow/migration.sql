-- Helpdesk → AI task manager.
--
-- Data is carried over, not dropped:
--   status   open → todo, in_progress → in_progress, resolved → needs_qa, closed → done
--            (statusRank recomputed from the new TASK_STATUSES order — applyTaskRanks()
--            only runs on application writes, so a migration must do it itself)
--   createdBy  "human:" + the old requesterEmail (already lowercase)
--   completedAt  the old closedAt, for tasks that land in done
--   category   dropped: the IT categories do not map onto projects
--   comments   author = "human:" + slugifyActorName(authorName), approximated in SQL below
-- Every migrated task gets a task.created event so the feed starts complete.

-- CreateTable
CREATE TABLE "TaskDependency" (
    "taskId" INTEGER NOT NULL,
    "dependsOnId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("taskId", "dependsOnId"),
    CONSTRAINT "TaskDependency_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskDependency_dependsOnId_fkey" FOREIGN KEY ("dependsOnId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "taskId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "question" TEXT NOT NULL,
    "options" TEXT NOT NULL,
    "recommendedOption" TEXT,
    "context" TEXT,
    "requestedBy" TEXT NOT NULL,
    "choice" TEXT,
    "note" TEXT,
    "answeredBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" DATETIME,
    CONSTRAINT "Decision_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TaskEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "taskId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Comment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "taskId" INTEGER NOT NULL,
    "author" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'note',
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Comment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Author = "human:" + slugifyActorName(authorName) (contracts/src/actor.ts),
-- done in flat steps because SQLite has no regex and a single expression
-- nesting every replace() overflows its parser: lowercase, ASCII punctuation
-- and whitespace to "-", runs of "-" collapsed, leading separators stripped,
-- cut to 64, trailing "-" stripped. An existing commenter keeps one actor name
-- across the migration and their next comment from the web app. (Non-ASCII
-- letters are kept as-is; SQLite cannot match the JS character class for them.)
INSERT INTO "new_Comment" ("id", "taskId", "author", "kind", "body", "createdAt")
SELECT "id", "taskId", lower(trim("authorName")), 'note', "body", "createdAt"
FROM "Comment";
UPDATE "new_Comment" SET "author" = replace("author", ' ', '-');
UPDATE "new_Comment" SET "author" = replace("author", char(9), '-');
UPDATE "new_Comment" SET "author" = replace("author", '''', '-');
UPDATE "new_Comment" SET "author" = replace("author", '"', '-');
UPDATE "new_Comment" SET "author" = replace("author", ',', '-');
UPDATE "new_Comment" SET "author" = replace("author", '(', '-');
UPDATE "new_Comment" SET "author" = replace("author", ')', '-');
UPDATE "new_Comment" SET "author" = replace("author", '!', '-');
UPDATE "new_Comment" SET "author" = replace("author", '?', '-');
UPDATE "new_Comment" SET "author" = replace("author", ':', '-');
UPDATE "new_Comment" SET "author" = replace("author", ';', '-');
UPDATE "new_Comment" SET "author" = replace("author", '+', '-');
UPDATE "new_Comment" SET "author" = replace("author", '&', '-');
UPDATE "new_Comment" SET "author" = replace("author", '#', '-');
UPDATE "new_Comment" SET "author" = replace("author", '%', '-');
UPDATE "new_Comment" SET "author" = replace("author", '*', '-');
UPDATE "new_Comment" SET "author" = replace("author", '=', '-');
UPDATE "new_Comment" SET "author" = replace("author", '[', '-');
UPDATE "new_Comment" SET "author" = replace("author", ']', '-');
UPDATE "new_Comment" SET "author" = replace("author", '{', '-');
UPDATE "new_Comment" SET "author" = replace("author", '}', '-');
UPDATE "new_Comment" SET "author" = replace("author", '|', '-');
UPDATE "new_Comment" SET "author" = replace("author", '\', '-');
UPDATE "new_Comment" SET "author" = replace("author", '~', '-');
UPDATE "new_Comment" SET "author" = replace("author", '`', '-');
UPDATE "new_Comment" SET "author" = replace("author", '^', '-');
UPDATE "new_Comment" SET "author" = replace("author", '<', '-');
UPDATE "new_Comment" SET "author" = replace("author", '>', '-');
UPDATE "new_Comment" SET "author" = replace("author", '$', '-');
UPDATE "new_Comment" SET "author" = replace("author", '--', '-');
UPDATE "new_Comment" SET "author" = replace("author", '--', '-');
UPDATE "new_Comment" SET "author" = replace("author", '--', '-');
UPDATE "new_Comment" SET "author" = replace("author", '--', '-');
UPDATE "new_Comment" SET "author" = replace("author", '--', '-');
UPDATE "new_Comment" SET "author" = replace("author", '--', '-');
UPDATE "new_Comment" SET "author" = rtrim(substr(ltrim("author", '-._@/'), 1, 64), '-');
UPDATE "new_Comment" SET "author" = 'human:' || coalesce(nullif("author", ''), 'anonymous');
DROP TABLE "Comment";
ALTER TABLE "new_Comment" RENAME TO "Comment";
CREATE INDEX "Comment_taskId_id_idx" ON "Comment"("taskId", "id");
CREATE TABLE "new_Task" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "acceptanceCriteria" TEXT,
    "status" TEXT NOT NULL DEFAULT 'backlog',
    "statusRank" INTEGER NOT NULL DEFAULT 0,
    "statusNote" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "priorityRank" INTEGER NOT NULL DEFAULT 1,
    "project" TEXT,
    "assignee" TEXT,
    "createdBy" TEXT NOT NULL,
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
INSERT INTO "new_Task" (
    "id", "title", "description", "status", "statusRank", "priority", "priorityRank",
    "assignee", "createdBy", "createdAt", "updatedAt", "completedAt"
)
SELECT
    "id", "title", "description",
    CASE "status"
        WHEN 'open' THEN 'todo'
        WHEN 'in_progress' THEN 'in_progress'
        WHEN 'resolved' THEN 'needs_qa'
        WHEN 'closed' THEN 'done'
        ELSE 'backlog'
    END,
    CASE "status"
        WHEN 'open' THEN 2
        WHEN 'in_progress' THEN 3
        WHEN 'resolved' THEN 7
        WHEN 'closed' THEN 8
        ELSE 0
    END,
    "priority", "priorityRank",
    "assignee", 'human:' || "requesterEmail", "createdAt", "updatedAt",
    CASE "status" WHEN 'closed' THEN "closedAt" ELSE NULL END
FROM "Task";
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
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "TaskDependency_dependsOnId_idx" ON "TaskDependency"("dependsOnId");

-- CreateIndex
CREATE INDEX "Decision_taskId_status_idx" ON "Decision"("taskId", "status");

-- CreateIndex
CREATE INDEX "TaskEvent_taskId_id_idx" ON "TaskEvent"("taskId", "id");


-- Seed the events feed with the tasks that already exist.
INSERT INTO "TaskEvent" ("taskId", "type", "actor", "payload", "createdAt")
SELECT "id", 'task.created', "createdBy", '{"migratedFrom":"helpdesk"}', "createdAt" FROM "Task" ORDER BY "id";
