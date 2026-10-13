import { type TaskExport } from "@estuary/contracts";
import { prisma } from "../lib/prisma.js";
import { serializeEvent, serializeTask } from "../lib/serialize.js";
import { detailInclude } from "./task-read.js";
export async function exportTasks(project?: string[]): Promise<TaskExport> {
  const where = project === undefined ? {} : { project: { in: project } };
  const [tasks, events] = await prisma.$transaction([
    prisma.task.findMany({ where, include: detailInclude, orderBy: { id: "asc" } }),
    prisma.taskEvent.findMany({ where, orderBy: { id: "asc" } }),
  ]);
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  return {
    format: "estuary-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    tasks: tasks.map(serializeTask),
    events: events.map((event) =>
      serializeEvent({ ...event, taskTitle: titles.get(event.taskId) ?? null }),
    ),
  };
}
