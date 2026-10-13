import { z } from "zod";
import { storedActorSchema } from "./actor.js";
import { claimSessionIdSchema } from "./handoff.js";
import { taskSchema } from "./task.js";
import { taskEventSchema } from "./event.js";
export const agentConnectionsSchema = z
  .object({
    data: z.array(
      z
        .object({
          actor: storedActorSchema,
          sessionId: claimSessionIdSchema,
          lastSeenAt: z.iso.datetime(),
        })
        .strict(),
    ),
  })
  .strict();
export type AgentConnections = z.infer<typeof agentConnectionsSchema>;
export const readinessSchema = z
  .object({ status: z.literal("ok"), database: z.literal("reachable") })
  .strict();
export type Readiness = z.infer<typeof readinessSchema>;
export const taskExportSchema = z
  .object({
    format: z.literal("estuary-export"),
    version: z.literal(1),
    exportedAt: z.iso.datetime(),
    tasks: z.array(taskSchema),
    events: z.array(taskEventSchema),
  })
  .strict();
export type TaskExport = z.infer<typeof taskExportSchema>;
