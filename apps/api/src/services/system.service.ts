import { type AgentConnections, type Readiness } from "@estuary/contracts";
import { prisma } from "../lib/prisma.js";
const sessions = new Map<string, { actor: string; sessionId: string; lastSeenAt: string }>();
const TTL = 5 * 60_000;
export const rememberAgentSession = (actor: string, sessionId: string, now = new Date()) => {
  for (const [key, value] of sessions)
    if (Date.parse(value.lastSeenAt) < now.getTime() - TTL) sessions.delete(key);
  sessions.set(`${actor}:${sessionId}`, { actor, sessionId, lastSeenAt: now.toISOString() });
  if (sessions.size > 1000) sessions.delete(sessions.keys().next().value!);
};
export const getAgentConnections = (now = new Date()): AgentConnections => ({
  data: [...sessions.values()]
    .filter((session) => Date.parse(session.lastSeenAt) >= now.getTime() - TTL)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
});
export const getReadiness = async (): Promise<Readiness> => {
  await prisma.task.count();
  return { status: "ok", database: "reachable" };
};
