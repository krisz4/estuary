import { createHmac, timingSafeEqual } from "node:crypto";

import {
  TASK_DESCRIPTION_MAX,
  TASK_DESCRIPTION_MIN,
  TASK_LINKS_MAX,
  TASK_TITLE_MAX,
  TASK_TITLE_MIN,
  createCommentInputSchema,
  createTaskInputSchema,
  findReferences,
  formatGithubUrl,
  githubImportKey,
  parseGithubUrl,
  projectSchema,
  type GithubImportInput,
  type GithubIntegrationStatus,
  type GithubItemRef,
  type GithubItemState,
  type GithubLinkStatus,
  type Task,
  type TaskGithubStatus,
} from "@estuary/contracts";

import { env } from "../lib/env.js";
import {
  ApiError,
  githubNotFound,
  githubUnavailable,
  integrationNotConfigured,
  invalidWebhookSignature,
  validationError,
} from "../lib/errors.js";
import {
  GithubApiError,
  createGithubClient,
  type GithubCheckState,
  type GithubClient,
} from "../lib/github-client.js";
import { prisma, writeTransaction } from "../lib/prisma.js";
import { addComment } from "./comment.service.js";
import { recordEvent } from "./task-events.js";
import { createTask, getTask, updateTask, type CreateTaskResult } from "./task.service.js";

/**
 * The optional GitHub integration — link status, issue import, and the
 * inbound webhook (`docs/features/GitHub_Integration.md`). Nothing here runs
 * unless the server is configured with `GITHUB_TOKEN` and/or
 * `GITHUB_WEBHOOK_SECRET`; every entry point checks that first.
 *
 * Every write the webhook makes is attributed to `system:github`, the same way
 * an auto-unblock is attributed to `system:taskmanager` — `actorKindOf()`
 * reads the `system:` prefix and the claim guard never refuses a system actor.
 */

export const SYSTEM_GITHUB_ACTOR = "system:github";

export const WEBHOOK_PATH = "/api/v1/integrations/github/webhook";

/* ------------------------------------------------------------------ *
 * Enablement
 * ------------------------------------------------------------------ */

export const isIntegrationEnabled = (): boolean =>
  env.GITHUB_TOKEN !== undefined || env.GITHUB_WEBHOOK_SECRET !== undefined;

export const isWebhookEnabled = (): boolean => env.GITHUB_WEBHOOK_SECRET !== undefined;

const assertIntegrationEnabled = (): void => {
  if (!isIntegrationEnabled()) throw integrationNotConfigured();
};

/** `GET /integrations/github` — reachable even when disabled, so a client can tell why. */
export const getIntegrationStatus = (): GithubIntegrationStatus => ({
  enabled: isIntegrationEnabled(),
  tokenConfigured: env.GITHUB_TOKEN !== undefined,
  webhookConfigured: env.GITHUB_WEBHOOK_SECRET !== undefined,
  webhookPath: WEBHOOK_PATH,
});

const isTaskNotFound = (err: unknown): boolean =>
  err instanceof ApiError && err.code === "TASK_NOT_FOUND";

/* ------------------------------------------------------------------ *
 * Webhook signature
 * ------------------------------------------------------------------ */

/**
 * HMAC-SHA256 of the **raw** request body against `X-Hub-Signature-256`,
 * compared with `timingSafeEqual` over equal-length buffers — the same
 * reasoning as `middleware/apiToken.ts`: a plain `===` leaks the correct
 * prefix through response timing.
 */
export const verifyWebhookSignature = (
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean => {
  if (signatureHeader === undefined) return false;

  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (match === null) return false;

  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"), "hex");
  const presented = Buffer.from(match[1]!, "hex");

  return expected.length === presented.length && timingSafeEqual(expected, presented);
};

/** Throws `INTEGRATION_NOT_CONFIGURED` (webhook secret unset) or `INVALID_WEBHOOK_SIGNATURE`. */
export const assertValidWebhookRequest = (
  rawBody: Buffer,
  signatureHeader: string | undefined,
): void => {
  if (!isWebhookEnabled()) throw integrationNotConfigured();
  if (!verifyWebhookSignature(rawBody, signatureHeader, env.GITHUB_WEBHOOK_SECRET!)) {
    throw invalidWebhookSignature();
  }
};

/* ------------------------------------------------------------------ *
 * Webhook processing — pull_request
 * ------------------------------------------------------------------ */

export interface WebhookResult {
  status: number;
  body: unknown;
}

const RELEVANT_PR_ACTIONS = ["opened", "reopened", "ready_for_review", "closed", "edited"] as const;

interface ParsedPullRequestEvent {
  action: string;
  number: number;
  title: string;
  body: string;
  headRef: string;
  headSha: string;
  htmlUrl: string;
  merged: boolean;
  repoFullName: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

/** Best-effort structural read of a `pull_request` webhook payload. `null` on anything unexpected. */
const parsePullRequestPayload = (payload: unknown): ParsedPullRequestEvent | null => {
  const root = asRecord(payload);
  const pr = asRecord(root?.pull_request);
  const repository = asRecord(root?.repository);
  const head = asRecord(pr?.head);
  if (root === null || pr === null || repository === null || head === null) return null;

  const action = root.action;
  const number = root.number;
  const title = pr.title;
  const body = pr.body;
  const htmlUrl = pr.html_url;
  const merged = pr.merged;
  const repoFullName = repository.full_name;
  const headRef = head.ref;
  const headSha = head.sha;

  if (
    typeof action !== "string" ||
    typeof number !== "number" ||
    typeof title !== "string" ||
    typeof htmlUrl !== "string" ||
    typeof repoFullName !== "string" ||
    typeof headRef !== "string" ||
    typeof headSha !== "string"
  ) {
    return null;
  }

  return {
    action,
    number,
    title,
    body: typeof body === "string" ? body : "",
    headRef,
    headSha,
    htmlUrl,
    merged: merged === true,
    repoFullName,
  };
};

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

/** One line per action; `null` means "no comment for this action" (ready_for_review, edited). */
const commentVerb = (action: string, merged: boolean): string | null => {
  if (action === "opened") return "opened";
  if (action === "reopened") return "reopened";
  if (action === "closed") return merged ? "merged" : "closed without merging";
  return null;
};

/**
 * Whether an event with this `deliveryId` was already recorded for this task —
 * GitHub redelivers, and a redelivery must not link/comment twice. `payload`
 * is a `String` column (`docs/engineering/DATABASE.md`), so this reads the
 * small set of `github.pull_request` rows for the task and parses each one,
 * rather than attempting a JSON predicate SQLite does not offer through Prisma.
 */
const hasDelivery = async (taskId: number, deliveryId: string): Promise<boolean> => {
  const rows = await prisma.taskEvent.findMany({
    where: { taskId, type: "github.pull_request" },
    select: { payload: true },
  });

  return rows.some((row) => {
    try {
      return (JSON.parse(row.payload) as { deliveryId?: unknown }).deliveryId === deliveryId;
    } catch {
      return false;
    }
  });
};

/** Appends the PR link via the core update path — no-op if already present or the task is full. */
const appendPullRequestLink = async (
  task: Task,
  ref: { label: string; url: string },
): Promise<void> => {
  const already = task.links.some(
    (link) => stripTrailingSlash(link.url) === stripTrailingSlash(ref.url),
  );
  if (already || task.links.length >= TASK_LINKS_MAX) return;

  await updateTask(task.id, { links: [...task.links, ref] }, SYSTEM_GITHUB_ACTOR);
};

/**
 * `POST /integrations/github/webhook` — the business logic behind the route.
 * Callers ({@link import("../routes/github.route.js")}) authenticate the
 * request (signature) and parse the JSON body before calling this; this
 * function never touches `req`/`res`.
 *
 * `ping` → `{ ok: true }`. `pull_request` with a relevant action → link, event,
 * and (for opened/reopened/closed) a comment, once per task per delivery.
 * Anything else → `{ ignored: true }`, 202.
 */
export const processGithubWebhook = async (event: {
  name: string;
  deliveryId: string;
  payload: unknown;
}): Promise<WebhookResult> => {
  if (event.name === "ping") return { status: 200, body: { ok: true } };
  if (event.name !== "pull_request") return { status: 202, body: { ignored: true } };

  const parsed = parsePullRequestPayload(event.payload);
  if (parsed === null || !(RELEVANT_PR_ACTIONS as readonly string[]).includes(parsed.action)) {
    return { status: 200, body: { linkedTasks: [] } };
  }

  const ids = findReferences(`${parsed.title}\n${parsed.body}\n${parsed.headRef}`);
  const linkedTasks: number[] = [];

  for (const taskId of ids) {
    const task = await getTask(taskId).catch((err: unknown) => {
      if (isTaskNotFound(err)) return null;
      throw err;
    });
    if (task === null) continue;

    linkedTasks.push(taskId);

    if (await hasDelivery(taskId, event.deliveryId)) continue;

    const label = `PR ${parsed.repoFullName}#${parsed.number}`;
    await appendPullRequestLink(task, { label, url: parsed.htmlUrl });

    await writeTransaction((tx) =>
      recordEvent(tx, {
        taskId,
        type: "github.pull_request",
        actor: SYSTEM_GITHUB_ACTOR,
        payload: {
          action: parsed.action,
          repo: parsed.repoFullName,
          number: parsed.number,
          url: parsed.htmlUrl,
          title: parsed.title,
          merged: parsed.merged,
          deliveryId: event.deliveryId,
        },
      }),
    );

    const verb = commentVerb(parsed.action, parsed.merged);
    if (verb !== null) {
      await addComment(
        taskId,
        createCommentInputSchema.parse({
          kind: "note",
          body: `${label} ${verb}: ${parsed.title} (${parsed.htmlUrl})`,
        }),
        SYSTEM_GITHUB_ACTOR,
      );
    }
  }

  return { status: 200, body: { linkedTasks } };
};

/* ------------------------------------------------------------------ *
 * Link status — GET /tasks/:taskId/github
 * ------------------------------------------------------------------ */

interface CacheEntry {
  data: GithubLinkStatus;
  expiresAt: number;
}

const LINK_STATUS_CACHE_TTL_MS = 60_000;
const linkStatusCache = new Map<string, CacheEntry>();

const mapCheckState = (raw: GithubCheckState): "success" | "failure" | "pending" =>
  raw === "success" || raw === "pending" ? raw : "failure";

const resolveLinkStatus = async (
  url: string,
  ref: GithubItemRef,
  client: GithubClient,
): Promise<GithubLinkStatus> => {
  const cached = linkStatusCache.get(url);
  const now = Date.now();
  if (cached !== undefined && cached.expiresAt > now) return cached.data;

  const repo = `${ref.owner}/${ref.repo}`;
  let result: GithubLinkStatus;

  try {
    if (ref.kind === "pull") {
      const pr = await client.getPullRequest(ref.owner, ref.repo, ref.number);
      const state: GithubItemState = pr.merged
        ? "merged"
        : pr.state === "open"
          ? pr.draft
            ? "draft"
            : "open"
          : "closed";

      let checks: "success" | "failure" | "pending" | null = null;
      try {
        const combined = await client.getCombinedStatus(ref.owner, ref.repo, pr.head.sha);
        checks = mapCheckState(combined.state);
      } catch {
        checks = null;
      }

      result = {
        url,
        kind: "pull",
        repo,
        number: ref.number,
        title: pr.title,
        state,
        checks,
        error: null,
        fetchedAt: new Date().toISOString(),
      };
    } else {
      const issue = await client.getIssue(ref.owner, ref.repo, ref.number);
      result = {
        url,
        kind: "issue",
        repo,
        number: ref.number,
        title: issue.title,
        state: issue.state === "open" ? "open" : "closed",
        checks: null,
        error: null,
        fetchedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    const message = err instanceof GithubApiError ? err.message : "GitHub request failed";
    result = {
      url,
      kind: ref.kind,
      repo,
      number: ref.number,
      title: null,
      state: null,
      checks: null,
      error: message,
      fetchedAt: new Date().toISOString(),
    };
  }

  linkStatusCache.set(url, { data: result, expiresAt: now + LINK_STATUS_CACHE_TTL_MS });
  return result;
};

/** Only for tests — the cache is otherwise process-lifetime, keyed by URL. */
export const clearLinkStatusCache = (): void => linkStatusCache.clear();

/**
 * `GET /tasks/:taskId/github` — every GitHub link on the task, resolved live
 * (60s cache per URL). One link's failure never fails the response; it carries
 * `error` instead of `state`.
 */
export const getTaskGithubStatus = async (
  taskId: number,
  client: GithubClient = createGithubClient(),
): Promise<TaskGithubStatus> => {
  assertIntegrationEnabled();
  const task = await getTask(taskId);

  const relevant = task.links
    .map((link) => ({ link, ref: parseGithubUrl(link.url) }))
    .filter(
      (entry): entry is { link: (typeof task.links)[number]; ref: GithubItemRef } =>
        entry.ref !== null,
    );

  const data = await Promise.all(
    relevant.map(({ link, ref }) => resolveLinkStatus(link.url, ref, client)),
  );

  return { data };
};

/* ------------------------------------------------------------------ *
 * Issue import — POST /integrations/github/import
 * ------------------------------------------------------------------ */

const clamp = (value: string, min: number, max: number): string => {
  const truncated = value.slice(0, max);
  return truncated.length >= min ? truncated : truncated.padEnd(min, ".");
};

/** `owner/repo` → a project slug, or `null` when the repo name is not one (`projectSchema` rejects it). */
const slugifyProjectFromRepo = (repo: string): string | null => {
  const parsed = projectSchema.safeParse(repo);
  return parsed.success ? parsed.data : null;
};

/**
 * `POST /integrations/github/import` — turns a GitHub issue into a task
 * through the core create service, so idempotency, validation, and the
 * `Location`/status-code rules are the same as a manual `POST /tasks`.
 */
export const importGithubIssue = async (
  input: GithubImportInput,
  actor: string,
  client: GithubClient = createGithubClient(),
): Promise<CreateTaskResult> => {
  assertIntegrationEnabled();

  // `githubImportInputSchema` already proved `input.issue` parses to an issue ref.
  const ref = parseGithubUrl(input.issue, true)!;

  let issue;
  try {
    issue = await client.getIssue(ref.owner, ref.repo, ref.number);
  } catch (err) {
    if (err instanceof GithubApiError && err.status === 404) throw githubNotFound();
    throw githubUnavailable();
  }

  if (issue.pull_request !== undefined) {
    throw validationError({ issue: ["That is a pull request, not an issue"] });
  }

  const url = formatGithubUrl(ref);
  const title = clamp(issue.title.trim(), TASK_TITLE_MIN, TASK_TITLE_MAX);
  const rawDescription = issue.body?.trim() ?? "";
  const description = clamp(
    rawDescription === "" ? `Imported from ${url}.` : rawDescription,
    TASK_DESCRIPTION_MIN,
    TASK_DESCRIPTION_MAX,
  );
  const project = input.project ?? slugifyProjectFromRepo(ref.repo);

  const createInput = createTaskInputSchema.parse({
    title,
    description,
    status: input.status,
    priority: input.priority,
    project,
    links: [{ label: `Issue ${ref.owner}/${ref.repo}#${ref.number}`, url }],
    labels: input.labels,
    idempotencyKey: githubImportKey(ref),
  });

  return createTask(createInput, actor);
};
