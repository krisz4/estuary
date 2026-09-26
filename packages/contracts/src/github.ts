import { z } from "zod";
import { labelsInputSchema, projectInputSchema, taskPrioritySchema } from "./task.js";

/**
 * The optional GitHub integration. See `docs/features/GitHub_Integration.md`.
 *
 * Off unless the API is given `GITHUB_TOKEN` and/or `GITHUB_WEBHOOK_SECRET`.
 * Nothing else in the API depends on it: with neither set, every route here
 * answers `INTEGRATION_NOT_CONFIGURED` and the rest of the app is unchanged.
 */

/** `GET /integrations/github` — what is switched on. Never echoes a secret. */
export const githubIntegrationStatusSchema = z
  .object({
    /** Either half is configured. */
    enabled: z.boolean(),
    /** `GITHUB_TOKEN` is set: link status and issue import can reach private repos. */
    tokenConfigured: z.boolean(),
    /** `GITHUB_WEBHOOK_SECRET` is set: the webhook route accepts signed deliveries. */
    webhookConfigured: z.boolean(),
    /** Path to point a GitHub webhook at, relative to the API origin. */
    webhookPath: z.string(),
  })
  .strict();
export type GithubIntegrationStatus = z.infer<typeof githubIntegrationStatusSchema>;

/* ------------------------------------------------------------------ *
 * URLs
 * ------------------------------------------------------------------ */

export const GITHUB_ITEM_KINDS = ["pull", "issue"] as const;
export type GithubItemKind = (typeof GITHUB_ITEM_KINDS)[number];

export type GithubItemRef = {
  owner: string;
  repo: string;
  kind: GithubItemKind;
  number: number;
};

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const REPO = "[A-Za-z0-9._-]{1,100}";
const GITHUB_URL = new RegExp(
  `^https?://(?:www\\.)?github\\.com/(${OWNER})/(${REPO})/(pull|issues)/(\\d{1,9})(?:[/?#].*)?$`,
);
const SHORTHAND = new RegExp(`^(${OWNER})/(${REPO})#(\\d{1,9})$`);

/**
 * `https://github.com/o/r/pull/12` (any trailing `/files`, `#discussion…`) or
 * `https://github.com/o/r/issues/7` → a ref; anything else → `null`.
 * With `allowShorthand`, `o/r#7` is accepted too and read as an issue (GitHub
 * resolves a PR number on the issues endpoint as well).
 */
export const parseGithubUrl = (input: string, allowShorthand = false): GithubItemRef | null => {
  const trimmed = input.trim();
  const url = GITHUB_URL.exec(trimmed);
  if (url !== null) {
    const [, owner, repo, segment, digits] = url;
    return {
      owner: owner!,
      repo: repo!.replace(/\.git$/, ""),
      kind: segment === "pull" ? "pull" : "issue",
      number: Number(digits),
    };
  }
  if (!allowShorthand) return null;
  const short = SHORTHAND.exec(trimmed);
  if (short === null) return null;
  const [, owner, repo, digits] = short;
  return { owner: owner!, repo: repo!, kind: "issue", number: Number(digits) };
};

export const formatGithubUrl = (ref: GithubItemRef): string =>
  `https://github.com/${ref.owner}/${ref.repo}/${ref.kind === "pull" ? "pull" : "issues"}/${ref.number}`;

/* ------------------------------------------------------------------ *
 * Link status — `GET /tasks/:taskId/github`
 * ------------------------------------------------------------------ */

export const GITHUB_ITEM_STATES = ["open", "draft", "merged", "closed"] as const;
export const githubItemStateSchema = z.enum(GITHUB_ITEM_STATES);
export type GithubItemState = z.infer<typeof githubItemStateSchema>;

/** Combined status of a PR's head commit; `null` for issues or when GitHub reports none. */
export const GITHUB_CHECK_STATES = ["success", "failure", "pending"] as const;
export const githubCheckStateSchema = z.enum(GITHUB_CHECK_STATES);

/**
 * One GitHub link on a task, resolved live. A link GitHub could not resolve
 * (deleted, private without a token, rate-limited) carries `error` instead of
 * `state` — one bad link never fails the whole response.
 */
export const githubLinkStatusSchema = z
  .object({
    url: z.string(),
    kind: z.enum(GITHUB_ITEM_KINDS),
    repo: z.string(), // "owner/repo"
    number: z.number().int().positive(),
    title: z.string().nullable(),
    state: githubItemStateSchema.nullable(),
    checks: githubCheckStateSchema.nullable(),
    error: z.string().nullable(),
    fetchedAt: z.iso.datetime(),
  })
  .strict();
export type GithubLinkStatus = z.infer<typeof githubLinkStatusSchema>;

export const taskGithubStatusSchema = z.object({ data: z.array(githubLinkStatusSchema) }).strict();
export type TaskGithubStatus = z.infer<typeof taskGithubStatusSchema>;

/* ------------------------------------------------------------------ *
 * Issue import — `POST /integrations/github/import`
 * ------------------------------------------------------------------ */

/**
 * Turns a GitHub issue into a task: its title, its body as the description,
 * and a link back. Idempotent per issue — importing the same open issue twice
 * returns the task the first import made (200), under the same rule as
 * `idempotencyKey` on create.
 *
 * `project` defaults to the repository's name as a slug.
 */
export const githubImportInputSchema = z
  .object({
    /** Issue URL, or `owner/repo#123`. */
    issue: z
      .string()
      .trim()
      .refine((value) => parseGithubUrl(value, true)?.kind === "issue", {
        message: 'Expected a GitHub issue URL or "owner/repo#123"',
      }),
    project: projectInputSchema.optional(),
    /** Not `todo`: an issue carries no acceptance criteria, and `todo` requires them. */
    status: z.enum(["backlog", "needs_refinement"]).default("backlog"),
    priority: taskPrioritySchema.optional(),
    labels: labelsInputSchema.optional(),
  })
  .strict();
export type GithubImportInput = z.infer<typeof githubImportInputSchema>;
export type GithubImportInputRaw = z.input<typeof githubImportInputSchema>;

/** The idempotency key an import uses, so a manual create can never collide with it by accident. */
export const githubImportKey = (ref: GithubItemRef): string =>
  `github:${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
