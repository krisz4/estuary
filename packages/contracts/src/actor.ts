import { z } from "zod";

/**
 * Actors — who performed a write.
 *
 * There are no accounts and no authentication (`docs/features/Actors.md`). An
 * actor is a **self-declared label**, sent on every request in the `X-Actor`
 * header, so the audit trail can tell an agent's change from a human's. It is
 * attribution, not identity: nothing stops a caller from claiming any label, and
 * nothing here should ever be read as a permission check it cannot back up. The
 * one rule that keys off the kind — agents stop at `needs_qa` unless
 * `AGENTS_MAY_COMPLETE` is on — is a guard against a well-behaved agent
 * overreaching, not against a hostile one.
 *
 * Canonical form is `kind:name`, lowercase, e.g. `agent:claude-code` or
 * `human:krisz`. Lowercased **in the schema** for the same reason
 * `requesterEmail` used to be: `createdBy` / `claimedBy` are exact-match filters
 * and SQLite's `equals` is case-sensitive.
 */

export const ACTOR_HEADER = "X-Actor";

export const ACTOR_KINDS = ["human", "agent", "system"] as const;
export const actorKindSchema = z.enum(ACTOR_KINDS);
export type ActorKind = z.infer<typeof actorKindSchema>;

export const ACTOR_NAME_MAX = 64;
export const ACTOR_PATTERN = new RegExp(
  `^(human|agent):[a-z0-9][a-z0-9._@/-]{0,${ACTOR_NAME_MAX - 1}}$`,
);

/**
 * A caller-supplied actor. `system` is deliberately not accepted from the wire —
 * it is reserved for writes the server makes on its own (auto-unblocking a
 * dependent task), so the timeline can never show a client impersonating it.
 */
export const actorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    ACTOR_PATTERN,
    'Actor must look like "agent:<name>" or "human:<name>" (letters, digits, . _ @ / -)',
  );
export type Actor = string;

/** What a request without an `X-Actor` header is attributed to. */
export const ANONYMOUS_ACTOR = "human:anonymous";
/** The author of writes the server makes by itself. Never accepted from a client. */
export const SYSTEM_ACTOR = "system:taskmanager";

/** Any stored actor, including `system:`. Used on response schemas. */
export const storedActorSchema = z.string().min(1);

export const actorKindOf = (actor: string): ActorKind => {
  const kind = actor.split(":", 1)[0];
  return kind === "agent" || kind === "system" ? kind : "human";
};

/** `"agent:claude-code"` → `"claude-code"`. */
export const actorNameOf = (actor: string): string => actor.slice(actor.indexOf(":") + 1);

/**
 * Turns a human's display name into the name half of an actor, so the web app
 * can send `human:<slug>` for whatever the viewer typed into "Your name".
 * Returns `null` when nothing usable remains.
 */
export const slugifyActorName = (displayName: string): string | null => {
  const slug = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._@/-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, ACTOR_NAME_MAX)
    // After the cut, so truncation cannot leave a dangling separator.
    .replace(/-+$/, "");
  return slug === "" ? null : slug;
};
