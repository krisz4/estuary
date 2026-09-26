import type { EventsQuery, EventsResponse, TaskEventType } from "@helpdesk/contracts";
import type { Prisma } from "@prisma/client";

import { prisma } from "../lib/prisma.js";
import { serializeEvent } from "../lib/serialize.js";

/**
 * The events feed: an append-only log of every write
 * (`docs/features/Task_Workflow_API.md` § Events).
 *
 * `recordEvent` takes the **transaction** client, never the global one, so an
 * event is written in the same commit as the change it describes. A write that
 * rolls back leaves no event behind, and a committed write never lacks one.
 */

type Db = Prisma.TransactionClient;

export interface NewEvent {
  taskId: number;
  type: TaskEventType;
  actor: string;
  /**
   * The task's project, to stamp on the event. Omit it and `recordEvent` looks
   * it up itself (inside the same transaction) — the normal case for every
   * write path in this file's package. The one caller that must pass it
   * explicitly is `deleteTask`: by the time its `task.deleted` event is
   * recorded the row is already gone, so there is nothing left to look up.
   */
  project?: string | null;
  payload?: Record<string, unknown>;
}

export async function recordEvent(db: Db, event: NewEvent): Promise<void> {
  let project = event.project;
  if (project === undefined) {
    const task = await db.task.findUnique({
      where: { id: event.taskId },
      select: { project: true },
    });
    project = task?.project ?? null;
  }

  await db.taskEvent.create({
    data: {
      taskId: event.taskId,
      type: event.type,
      actor: event.actor,
      project,
      payload: JSON.stringify(event.payload ?? {}),
    },
  });
}

/**
 * `GET /events` — oldest first by default (`order=asc`), strictly after the
 * cursor; the Logbook pages backwards with `order=desc` and `before` instead.
 *
 * Fetches `limit + 1` rows to learn whether more exist without a count query.
 *
 * **`order=asc` is byte-identical to the original poller behaviour** — the
 * `where` and `orderBy` below reduce to exactly what they were before `before`
 * / `order` / `from` / `to` existed whenever none of those are sent, so an
 * existing poller sending only `after` and `taskId` (etc.) is unaffected.
 *
 * `nextAfter` is the last id returned, or the incoming cursor when nothing new
 * happened, so a poller can feed it straight back in either case — including a
 * `desc` page, where it becomes the *largest* id on the page, since that is the
 * cursor a poller would want if it started following the feed live from here.
 * `nextBefore` is the Logbook's cursor: the smallest id on a `desc` page, to
 * request the next (older) page with `before=`; always `null` on `asc`, and
 * `null` on `desc` too once the page comes back empty.
 */
export async function listEvents(query: EventsQuery): Promise<EventsResponse> {
  const after = query.after ?? 0;
  const isDesc = query.order === "desc";

  const idFilter: { gt?: number; lt?: number } = {};
  if (query.after !== undefined || !isDesc) idFilter.gt = after;
  if (query.before !== undefined) idFilter.lt = query.before;

  // `from` is inclusive, `to` exclusive — instants, not dates.
  const createdAtFilter: { gte?: Date; lt?: Date } = {};
  if (query.from !== undefined) createdAtFilter.gte = new Date(query.from);
  if (query.to !== undefined) createdAtFilter.lt = new Date(query.to);

  const rows = await prisma.taskEvent.findMany({
    where: {
      id: idFilter,
      ...(query.from === undefined && query.to === undefined ? {} : { createdAt: createdAtFilter }),
      ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
      ...(query.project === undefined ? {} : { project: { in: query.project } }),
      ...(query.actor === undefined ? {} : { actor: query.actor }),
      ...(query.type === undefined ? {} : { type: { in: query.type } }),
    },
    orderBy: { id: isDesc ? "desc" : "asc" },
    take: query.limit + 1,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  const nextAfter = isDesc ? (page[0]?.id ?? after) : (page.at(-1)?.id ?? after);
  const nextBefore = isDesc ? (page.at(-1)?.id ?? null) : null;

  const titleFor = await titlesForTasks(page.map((row) => row.taskId));

  return {
    data: page.map((row) => serializeEvent({ ...row, taskTitle: titleFor.get(row.taskId) ?? null })),
    meta: { nextAfter, nextBefore, hasMore },
  };
}

/**
 * Current titles for a page's distinct `taskId`s, in one query — `null` for
 * any id that no longer exists (the task was deleted since the event).
 */
async function titlesForTasks(taskIds: number[]): Promise<Map<number, string>> {
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return new Map();
  const rows = await prisma.task.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true },
  });
  return new Map(rows.map((row) => [row.id, row.title]));
}
