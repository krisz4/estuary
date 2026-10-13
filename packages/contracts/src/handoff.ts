import { z } from "zod";

export const CLAIM_SESSION_HEADER = "X-Claim-Session";
export const claimSessionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/, "Use letters, digits, . _ : - for a session id");
const text = z.string().trim().min(1).max(2000);
/**
 * What a QA agent can show for its run, by link — Estuary stores no files, so a
 * photo or recording is a URL the agent uploaded it to (a PR comment, a bucket,
 * a gist). `doc` is documentation the change added or follows. http(s) only: the
 * web renders `photo` as an image and the rest as links.
 */
export const QA_EVIDENCE_KINDS = ["photo", "video", "doc", "link"] as const;
export const QA_EVIDENCE_MAX = 20;
export const qaEvidenceItemSchema = z
  .object({
    kind: z.enum(QA_EVIDENCE_KINDS),
    url: z.url({ protocol: /^https?$/, error: "Enter an http(s) URL" }).max(2000),
    /** What it shows, e.g. "Inbox badge after approving, 360px". */
    description: text.optional(),
  })
  .strict();
export type QaEvidenceItem = z.infer<typeof qaEvidenceItemSchema>;
const qaEvidenceItems = z
  .array(qaEvidenceItemSchema)
  .max(QA_EVIDENCE_MAX, `At most ${QA_EVIDENCE_MAX} evidence items`)
  .optional();
/**
 * How the agent QA'd the change, beyond the checks it ran. Either it exercised
 * the change on a running device — a simulator, emulator, phone, or browser —
 * scenario by scenario, or it says why no device check is needed (an API-only
 * or refactor change its checks already cover). Either one, with every result
 * passing, is what lets an agent move a task to `verified` — see `qualifiesForVerified`.
 */
export const qaEvidenceSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("device"),
      /** What it ran on, e.g. "iPhone 16 simulator, iOS 18.4" or "Chromium, 360px". */
      target: text,
      scenarios: z
        .array(z.object({ scenario: text, result: z.enum(["passed", "failed"]) }).strict())
        .min(1)
        .max(30),
      /** What the run looked like, beyond the scenario list. */
      notes: text.optional(),
      evidence: qaEvidenceItems,
    })
    .strict(),
  z
    .object({
      method: z.literal("not_needed"),
      /** Why the checks alone prove it, e.g. "API-only change; covered by route tests". */
      reason: text,
      evidence: qaEvidenceItems,
    })
    .strict(),
]);
export type QaEvidence = z.infer<typeof qaEvidenceSchema>;
export const verificationSchema = z
  .object({
    commit: z
      .string()
      .trim()
      .min(7)
      .max(64)
      .regex(/^[a-fA-F0-9]+$/, "Enter the tested commit SHA"),
    checks: z
      .array(
        z
          .object({
            command: text,
            result: z.enum(["passed", "failed", "not_run"]),
            output: text.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    criteria: z
      .array(
        z.object({ criterion: text, result: z.enum(["passed", "failed", "not_checked"]) }).strict(),
      )
      .min(1)
      .max(30),
    qa: qaEvidenceSchema.optional(),
  })
  .strict();
export type Verification = z.infer<typeof verificationSchema>;
export const checkpointSchema = z
  .object({
    branch: z.string().trim().min(1).max(250).optional(),
    commit: z
      .string()
      .trim()
      .min(7)
      .max(64)
      .regex(/^[a-fA-F0-9]+$/)
      .optional(),
    completed: text,
    remaining: text,
  })
  .strict();
export type Checkpoint = z.infer<typeof checkpointSchema>;
/** Eligibility based on reported evidence; a human still verifies the work. */
export const hasPassingVerification = (value: Verification | null | undefined): boolean =>
  value != null &&
  value.checks.length > 0 &&
  value.criteria.length > 0 &&
  value.checks.every((check) => check.result === "passed") &&
  value.criteria.every((criterion) => criterion.result === "passed") &&
  (value.qa?.method !== "device" ||
    value.qa.scenarios.every((scenario) => scenario.result === "passed"));
/**
 * Whether evidence is enough for a task to be `verified`: every check,
 * criterion, and device scenario passed, and the agent either QA'd on a device
 * or said why the checks alone prove the change.
 */
export const qualifiesForVerified = (value: Verification | null | undefined): boolean =>
  hasPassingVerification(value) && value?.qa !== undefined;
