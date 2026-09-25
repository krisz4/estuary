import { z } from "zod";
import { storedActorSchema } from "./actor.js";

/**
 * Decisions — the structured half of `needs_user_decision`.
 *
 * An agent that cannot proceed without a human's call does not bury the question
 * in a comment: it transitions the task to `needs_user_decision` with a
 * question, at least two options, and optionally its own recommendation. The
 * human answers with `POST /tasks/:taskId/decision/answer`, which records the
 * answer and hands the task back to `todo` for the next agent to pick up with
 * the answer in hand. See `docs/features/Decisions.md`.
 *
 * A task has **at most one open decision**. Moving the task out of
 * `needs_user_decision` any other way (dragging it on the board, say) withdraws
 * the open one rather than leaving it dangling.
 *
 * This module imports nothing from `task.ts` — `task.ts` embeds the open
 * decision in its response, so a back-import would close a cycle.
 */

export const DECISION_STATUSES = ["open", "answered", "withdrawn"] as const;
export const decisionStatusSchema = z.enum(DECISION_STATUSES);
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;

export const DECISION_QUESTION_MAX = 1000;
export const DECISION_OPTION_LABEL_MAX = 120;
export const DECISION_OPTION_DESCRIPTION_MAX = 1000;
export const DECISION_OPTIONS_MIN = 2;
export const DECISION_OPTIONS_MAX = 6;
export const DECISION_CONTEXT_MAX = 5000;
export const DECISION_ANSWER_MAX = 2000;

export const decisionOptionSchema = z
  .object({
    label: z.string().trim().min(1, "Option label is required").max(DECISION_OPTION_LABEL_MAX),
    description: z.string().trim().max(DECISION_OPTION_DESCRIPTION_MAX).optional(),
  })
  .strict();
export type DecisionOption = z.infer<typeof decisionOptionSchema>;

/**
 * The payload of a `→ needs_user_decision` transition. `recommendedOption`, when
 * present, must be one of the option labels — an agent recommending something it
 * did not offer is a bug worth a 422.
 */
export const decisionRequestSchema = z
  .object({
    question: z.string().trim().min(5, "Ask a real question").max(DECISION_QUESTION_MAX),
    options: z
      .array(decisionOptionSchema)
      .min(DECISION_OPTIONS_MIN, `Offer at least ${DECISION_OPTIONS_MIN} options`)
      .max(DECISION_OPTIONS_MAX, `Offer at most ${DECISION_OPTIONS_MAX} options`),
    recommendedOption: z.string().trim().min(1).max(DECISION_OPTION_LABEL_MAX).optional(),
    context: z.string().trim().max(DECISION_CONTEXT_MAX).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const labels = value.options.map((option) => option.label);
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Option labels must be unique" });
    }
    if (value.recommendedOption !== undefined && !labels.includes(value.recommendedOption)) {
      ctx.addIssue({
        code: "custom",
        path: ["recommendedOption"],
        message: "recommendedOption must be one of the option labels",
      });
    }
  });
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;

/**
 * `POST /tasks/:taskId/decision/answer`. Either pick an option, write a free-form
 * answer, or both ("B, but keep the old endpoint for a release"). `choice` must
 * match an option label of the open decision — checked by the service, since the
 * options live in the database, not in this payload.
 */
export const answerDecisionInputSchema = z
  .object({
    choice: z.string().trim().min(1).max(DECISION_OPTION_LABEL_MAX).optional(),
    note: z.string().trim().min(1).max(DECISION_ANSWER_MAX).optional(),
  })
  .strict()
  .refine((value) => value.choice !== undefined || value.note !== undefined, {
    message: "Pick an option or write an answer",
    path: ["choice"],
  });
export type AnswerDecisionInput = z.infer<typeof answerDecisionInputSchema>;

export const decisionSchema = z
  .object({
    id: z.number().int().positive(),
    taskId: z.number().int().positive(),
    status: decisionStatusSchema,
    question: z.string(),
    options: z.array(decisionOptionSchema),
    recommendedOption: z.string().nullable(),
    context: z.string().nullable(),
    requestedBy: storedActorSchema,
    choice: z.string().nullable(),
    note: z.string().nullable(),
    answeredBy: storedActorSchema.nullable(),
    createdAt: z.iso.datetime(),
    answeredAt: z.iso.datetime().nullable(),
  })
  .strict();
export type Decision = z.infer<typeof decisionSchema>;
