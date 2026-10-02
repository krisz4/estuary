import { z } from "zod";
import { decisionRequestSchema } from "./decision.js";
import {
  acceptanceCriteriaInputSchema,
  descriptionInputSchema,
  expectedVersionSchema,
  labelSchema,
  projectSchema,
  TASK_CONCERNS_MAX,
  TASK_FOLLOW_UPS_MAX,
  TASK_STATUS_NOTE_MAX,
  titleInputSchema,
  taskIdSchema,
  taskLinksInputSchema,
  taskPrioritySchema,
  taskSchema,
} from "./task.js";

/**
 * The agent-facing workflow surface: status transitions, claims, and
 * dependencies. See `docs/features/Task_Status_Lifecycle.md` and
 * `docs/features/Claims.md`.
 */

/* ------------------------------------------------------------------ *
 * Transitions — `POST /tasks/:taskId/transition`
 * ------------------------------------------------------------------ */

/**
 * A free-text note. `message` is what a caller sees when it is missing or blank —
 * the web shows it under the field and an agent reads it in `details`, so it
 * says what to write rather than "expected string to have >=1 characters".
 */
const noteField = (message = "Cannot be empty") =>
  z
    .string({ error: message })
    .trim()
    .min(1, message)
    .max(TASK_STATUS_NOTE_MAX, `Must be at most ${TASK_STATUS_NOTE_MAX} characters`);

const note = noteField();

const base = { expectedVersion: expectedVersionSchema };

/**
 * Work an agent found but did not do — a recommendation, the part it left out,
 * a bug next door. Carried on the hand-off itself (`needs_qa`, release) so
 * filing it costs the agent no extra call, and so it cannot be forgotten
 * between "I'm done" and the session ending.
 *
 * The server files each one as a subtask of the task being handed off, in the
 * same project with the same labels, marked `needsTriage`: **`todo`** when it
 * has acceptance criteria, otherwise **`needs_refinement`** with `missing` (or a
 * default) as the note. A follow-up whose title is already an open subtask of
 * the same task is skipped, so a retried hand-off does not file it twice.
 */
export const followUpInputSchema = z
  .object({
    title: titleInputSchema,
    description: descriptionInputSchema,
    acceptanceCriteria: acceptanceCriteriaInputSchema.optional(),
    /** What a person must decide or supply before it can be `todo`. */
    missing: note.optional(),
    priority: taskPrioritySchema.optional(),
  })
  .strict();
export type FollowUpInput = z.infer<typeof followUpInputSchema>;

const followUps = z
  .array(followUpInputSchema)
  .max(TASK_FOLLOW_UPS_MAX, `At most ${TASK_FOLLOW_UPS_MAX} follow-ups per hand-off`)
  .optional();

/**
 * One schema per target status, discriminated on `to`. **What a status requires
 * is expressed as the shape of its payload**, so a missing reason or question is
 * an ordinary `VALIDATION_ERROR` with a per-field message — the same error an
 * agent already knows how to read — rather than a bespoke code.
 *
 * There is no from→to table. Any status may move to any other; the payload is
 * the gate. The one exception is actor-based: an `agent:` actor may not move a
 * task to `done` unless the server runs with `AGENTS_MAY_COMPLETE=true`
 * (`ACTOR_NOT_PERMITTED`, 403). Agents hand finished work to `needs_qa`.
 *
 * `reason` / `instructions` / `summary` become the task's `statusNote`.
 */
export const transitionInputSchema = z.discriminatedUnion("to", [
  z.object({ to: z.literal("backlog"), reason: note.optional(), ...base }).strict(),
  z
    .object({
      to: z.literal("needs_refinement"),
      /** What is unclear or missing. */
      reason: noteField("Say what is unclear or missing"),
      ...base,
    })
    .strict(),
  z
    .object({
      to: z.literal("todo"),
      /**
       * Sets the task's acceptance criteria in the same write. Required unless the
       * task already has some — the service checks the combination, because only
       * it can see the stored value.
       */
      acceptanceCriteria: acceptanceCriteriaInputSchema.optional(),
      reason: note.optional(),
      ...base,
    })
    .strict(),
  z
    .object({
      to: z.literal("in_progress"),
      /** Claims the task for the caller, as `POST /tasks/:taskId/claim` would. */
      reason: note.optional(),
      ...base,
    })
    .strict(),
  z
    .object({
      to: z.literal("blocked"),
      /** Why, in words. Required unless `blockedBy` names at least one task. */
      reason: note.optional(),
      /** Tasks this one waits on; added as dependencies. */
      blockedBy: z.array(taskIdSchema).max(20).optional(),
      ...base,
    })
    .strict()
    .refine((value) => value.reason !== undefined || (value.blockedBy?.length ?? 0) > 0, {
      message: "Say why it is blocked, or name the tasks it waits on in blockedBy",
      path: ["reason"],
    }),
  z
    .object({
      to: z.literal("needs_user_decision"),
      decision: decisionRequestSchema,
      ...base,
    })
    .strict(),
  z
    .object({
      to: z.literal("needs_user_action"),
      /** Exactly what the human has to do, and where. Becomes the status note. */
      instructions: noteField("Say exactly what the human has to do"),
      ...base,
    })
    .strict(),
  z
    .object({
      to: z.literal("needs_qa"),
      /** What changed and how to verify it. */
      summary: noteField("Summarise what changed and how to verify it"),
      /** Appended to the task's links (PR, branch, commit). */
      links: taskLinksInputSchema.optional(),
      /**
       * Only when a reviewer must look at something specific: a deviation from
       * the criteria, a risk, a shortcut. Omit for a routine hand-off — the inbox
       * then offers it for one-click approval instead of asking for a read.
       */
      concerns: z
        .string()
        .trim()
        .min(1)
        .max(TASK_CONCERNS_MAX, `Must be at most ${TASK_CONCERNS_MAX} characters`)
        .optional(),
      followUps,
      ...base,
    })
    .strict(),
  z.object({ to: z.literal("done"), reason: note.optional(), ...base }).strict(),
  z
    .object({
      to: z.literal("deferred"),
      /** Why it is parked. Required so the deferred pile stays reviewable. */
      reason: noteField("Say why it is being parked"),
      ...base,
    })
    .strict(),
]);
export type TransitionInput = z.infer<typeof transitionInputSchema>;
export type TransitionInputRaw = z.input<typeof transitionInputSchema>;

/* ------------------------------------------------------------------ *
 * Claims
 * ------------------------------------------------------------------ */

/**
 * `POST /tasks/next` — atomically claim the best available task and move it to
 * `in_progress`. "Best" is: `todo` with no unfinished dependencies, or
 * `in_progress` whose lease has expired (a crashed agent's work), highest
 * priority first, then oldest.
 */
export const nextTaskInputSchema = z
  .object({
    /** Only consider these projects. Omit for any project. */
    project: z.array(projectSchema).min(1).optional(),
    /**
     * Only consider tasks carrying at least one of these labels — how an agent
     * working in one workspace of a monorepo (`web`) asks for that workspace's
     * work. Omit for any label, including unlabelled tasks.
     */
    label: z.array(labelSchema).min(1).optional(),
    /** Only consider tasks at or above this priority. */
    minPriority: taskPrioritySchema.optional(),
  })
  .strict();
export type NextTaskInput = z.infer<typeof nextTaskInputSchema>;

/** `{ task: null }` when there is nothing to do — not a 404, since nothing is missing. */
export const nextTaskResponseSchema = z.object({ task: taskSchema.nullable() }).strict();
export type NextTaskResponse = z.infer<typeof nextTaskResponseSchema>;

/** `POST /tasks/:taskId/claim` — the same as transitioning to `in_progress`. */
export const claimTaskInputSchema = z.object({ expectedVersion: expectedVersionSchema }).strict();
export type ClaimTaskInput = z.infer<typeof claimTaskInputSchema>;

/**
 * `POST /tasks/:taskId/release` — the claim holder gives the task up. It goes
 * back to `todo` so another agent can take it.
 */
export const releaseTaskInputSchema = z
  .object({
    reason: note.optional(),
    followUps,
    expectedVersion: expectedVersionSchema,
  })
  .strict();
export type ReleaseTaskInput = z.infer<typeof releaseTaskInputSchema>;

/* ------------------------------------------------------------------ *
 * Dependencies
 * ------------------------------------------------------------------ */

/**
 * `POST /tasks/:taskId/dependencies` — this task depends on `dependsOnId`.
 * Self-dependency is a 422; a cycle is `DEPENDENCY_CYCLE` (409).
 */
export const addDependencyInputSchema = z.object({ dependsOnId: taskIdSchema }).strict();
export type AddDependencyInput = z.infer<typeof addDependencyInputSchema>;

/* ------------------------------------------------------------------ *
 * Cleanup — `POST /tasks/cleanup`
 * ------------------------------------------------------------------ */

/** Longest `olderThanDays` / `DONE_RETENTION_DAYS` accepted: ten years. */
export const CLEANUP_MAX_DAYS = 3650;

/**
 * Hard-delete `done` tasks in bulk. Only `done` — no other status is ever
 * touched. `olderThanDays` counts from when the task was completed; omit it (or
 * send 0) to delete every done task in scope. `dryRun` reports what would go
 * without deleting anything — the web's confirm dialog uses it for its count.
 */
export const cleanupDoneTasksInputSchema = z
  .object({
    /** Only these projects. Omit for every project. */
    project: z.array(projectSchema).min(1).optional(),
    olderThanDays: z.number().int().min(0).max(CLEANUP_MAX_DAYS).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();
export type CleanupDoneTasksInput = z.infer<typeof cleanupDoneTasksInputSchema>;

export const cleanupDoneTasksResponseSchema = z
  .object({
    /** How many tasks were deleted — or, on a dry run, would be. */
    deleted: z.number().int().nonnegative(),
    taskIds: z.array(taskIdSchema),
    dryRun: z.boolean(),
  })
  .strict();
export type CleanupDoneTasksResponse = z.infer<typeof cleanupDoneTasksResponseSchema>;
