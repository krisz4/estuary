import { createHash } from "node:crypto";

import { TASK_IDEMPOTENCY_KEY_MAX } from "@helpdesk/contracts";

/**
 * The idempotency key `task_create` sends when the caller did not pick one.
 *
 * Derived from **what the task is about** (project + title), not from a random
 * id, because the failure it guards against is an agent re-running: a retried
 * tool call, a resumed session, or a second agent noticing the same follow-up.
 * All of those produce the same project and title, so they land on the task the
 * first call created instead of filing a duplicate. A random key would only
 * cover the first of the three.
 *
 * The cost is that re-filing a genuinely new task under an old title returns
 * the old one; the tool description tells agents to pass their own key then.
 *
 * Title normalisation is deliberately loose (case, punctuation, whitespace), so
 * "Fix flaky login test" and "fix flaky login test." collide — they are the
 * same task written twice. Long titles are cut and suffixed with a hash of the
 * full title, so two titles sharing a long prefix still get different keys.
 */

const PREFIX = "mcp";
const HASH_LENGTH = 10;

const slugify = (title: string): string =>
  title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const deriveIdempotencyKey = (project: string | null | undefined, title: string): string => {
  // A title with no ASCII letters or digits ("修复登录") slugs to nothing; hash it instead.
  const slug =
    slugify(title) || createHash("sha256").update(title.trim()).digest("hex").slice(0, 32);
  const scope = project ?? "no-project";
  // What is left of the key's length budget once the prefix and project are in.
  const room = TASK_IDEMPOTENCY_KEY_MAX - PREFIX.length - scope.length - 2;
  const body =
    slug.length <= room
      ? slug
      : `${slug.slice(0, room - HASH_LENGTH - 1)}-${createHash("sha256").update(slug).digest("hex").slice(0, HASH_LENGTH)}`;
  return `${PREFIX}:${scope}:${body}`;
};
