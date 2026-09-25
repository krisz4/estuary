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
  payload?: Record<string, unknown>;
}

export async function recordEvent(db: Db, event: NewEvent): Promise<void> {
  await db.taskEvent.create({
    data: {
      taskId: event.taskId,
      type: event.type,
      actor: event.actor,
      payload: JSON.stringify(event.payload ?? {}),
    },
  });
}

/**
 * `GET /events` — oldest first, strictly after the cursor.
 *
 * Fetches `limit + 1` rows to learn whether more exist without a count query.
 * `nextAfter` is the last id returned, or the incoming cursor when nothing new
 * happened, so a poller can feed it straight back in either case.
 */
export async function listEvents(query: EventsQuery): Promise<EventsResponse> {
  const after = query.after ?? 0;

  const rows = await prisma.taskEvent.findMany({
    where: {
      id: { gt: after },
      ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
    },
    orderBy: { id: "asc" },
    take: query.limit + 1,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  return {
    data: page.map(serializeEvent),
    meta: { nextAfter: page.at(-1)?.id ?? after, hasMore },
  };
}
