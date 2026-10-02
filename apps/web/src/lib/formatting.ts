import {
  actorKindOf,
  actorNameOf,
  COMMENT_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type ActorKind,
  type CommentKind,
  type TaskPriority,
  type TaskStatus,
} from "@estuary/contracts";

/**
 * Presentation helpers. Nothing here knows about the network or React.
 *
 * Enum labels are written out per value rather than derived by de-underscoring
 * and title-casing. A derivation would render `needs_user_decision` as "Needs
 * User Decision" — accurate and unreadable in a narrow chip — and, more to
 * the point, it would silently produce a plausible-looking label for a value
 * that is not in the enum at all, which is the case worth surfacing.
 */

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  needs_refinement: "Needs refinement",
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  needs_user_decision: "Needs decision",
  needs_user_action: "Needs action",
  needs_qa: "Needs QA",
  done: "Done",
  deferred: "Deferred",
};

/**
 * One line on what each status *means* — a status hint on the map and the
 * option description in the transition dialog. The lifecycle is new enough to
 * everyone (human and agent) that "Needs refinement" vs "Backlog" deserves a
 * sentence rather than a guess.
 */
export const TASK_STATUS_DESCRIPTIONS: Record<TaskStatus, string> = {
  backlog: "Captured, not planned yet.",
  needs_refinement: "Unclear — needs more detail before anyone can start.",
  todo: "Ready to pick up. Has acceptance criteria.",
  in_progress: "Being worked on, and claimed by whoever is on it.",
  blocked: "Waiting on other tasks or on something external.",
  needs_user_decision: "An agent asked a question only a human can answer.",
  needs_user_action: "A human has to do a manual step.",
  needs_qa: "The work is done. Someone needs to verify it.",
  done: "Finished and verified.",
  deferred: "Parked on purpose. The reason is recorded.",
};

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export const COMMENT_KIND_LABELS: Record<CommentKind, string> = {
  note: "Note",
  progress: "Progress",
  qa_feedback: "QA feedback",
};

export const ACTOR_KIND_LABELS: Record<ActorKind, string> = {
  human: "Human",
  agent: "Agent",
  system: "System",
};

/** Options in enum order, ready for a `<Select>`. */
export const statusOptions = TASK_STATUSES.map((value) => ({
  value,
  label: TASK_STATUS_LABELS[value],
}));

export const priorityOptions = TASK_PRIORITIES.map((value) => ({
  value,
  label: TASK_PRIORITY_LABELS[value],
}));

export const commentKindOptions = COMMENT_KINDS.map((value) => ({
  value,
  label: COMMENT_KIND_LABELS[value],
}));

/* ------------------------------------------------------------------ *
 * Actors
 * ------------------------------------------------------------------ */

/**
 * `"agent:claude-code"` → `"claude-code"`; the kind is rendered separately, as
 * a badge, so it is never folded into the name. The one special case is the
 * default a request without `X-Actor` is attributed to, which reads better as
 * words than as a slug.
 */
export const actorDisplayName = (actor: string): string => {
  const name = actorNameOf(actor);
  if (actorKindOf(actor) === "human" && name === "anonymous") return "Anonymous";
  return name;
};

/* ------------------------------------------------------------------ *
 * Dates
 *
 * The design guidelines ask for relative text in the UI and an absolute value
 * in `title` / `<time datetime>`. All three come from one ISO string, so a
 * caller cannot accidentally show a relative label with an unrelated tooltip.
 * ------------------------------------------------------------------ */

const ABSOLUTE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const DATE_ONLY_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

const RELATIVE_FORMAT = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

const parse = (iso: string): Date | null => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** `"2026-08-09T10:00:00.000Z"` → `"2 days ago"`. Invalid input returns `"—"`. */
export const formatRelative = (iso: string, now: Date = new Date()): string => {
  const date = parse(iso);
  if (date === null) return "—";

  let duration = (date.getTime() - now.getTime()) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return RELATIVE_FORMAT.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return ABSOLUTE_FORMAT.format(date);
};

/** Full local date and time, for `title` attributes. */
export const formatAbsolute = (iso: string): string => {
  const date = parse(iso);
  return date === null ? "—" : ABSOLUTE_FORMAT.format(date);
};

/**
 * `"2 weeks ago"` → `"2w"` — for a column too narrow to wrap ("2 weeks /
 * ago" is worse than either "2w" or a full-length age; a fixed, tight token
 * fits every case). Always pair with `title={formatAbsolute(iso)}` for the
 * full date on hover — the whole point of shortening it is that the detail
 * isn't lost, just not always shown.
 */
export const formatCompactAge = (iso: string, now: Date = new Date()): string => {
  const date = parse(iso);
  if (date === null) return "—";
  const seconds = Math.abs((now.getTime() - date.getTime()) / 1000);
  const units: { limit: number; divisor: number; suffix: string }[] = [
    { limit: 60, divisor: 1, suffix: "s" },
    { limit: 3600, divisor: 60, suffix: "m" },
    { limit: 86_400, divisor: 3600, suffix: "h" },
    { limit: 604_800, divisor: 86_400, suffix: "d" },
    { limit: 2_629_800, divisor: 604_800, suffix: "w" },
    { limit: 31_557_600, divisor: 2_629_800, suffix: "mo" },
    { limit: Number.POSITIVE_INFINITY, divisor: 31_557_600, suffix: "y" },
  ];
  const unit = units.find((entry) => seconds < entry.limit) ?? units[units.length - 1]!;
  const value = Math.max(1, Math.floor(seconds / unit.divisor));
  return `${value}${unit.suffix}`;
};

/**
 * Date without a time, **in the viewer's timezone**, for an instant that has one
 * — a `createdAt`, a `completedAt`.
 *
 * Not for a `YYYY-MM-DD` filter bound: that string has no instant behind it, and
 * this function would resolve it to UTC midnight and then render it in local
 * time. Use `formatDateOnly` for those.
 */
export const formatDate = (iso: string): string => {
  const date = parse(iso);
  return date === null ? "—" : DATE_ONLY_FORMAT.format(date);
};

/**
 * A date-only string (`2026-08-01`) rendered as the day it names, everywhere.
 *
 * `new Date("2026-08-01")` is UTC midnight by spec, so formatting it with the
 * viewer's timezone renders `Jul 31, 2026` anywhere west of Greenwich — a filter
 * bound labelled "Created from (UTC) = 2026-08-01" whose chip reads the day
 * before. `createdFrom` / `createdTo` are UTC calendar days by contract
 * (`docs/features/Task_Query_Filter_Sort_Page.md` § Date bounds), so the
 * formatter is pinned to UTC rather than the reader's clock.
 *
 * The pinning is on the formatter, not on the parse: a `timeZone` passed here
 * cannot be undone by an ambient `TZ`, whereas re-deriving local Y/M/D from the
 * instant would be one more place to get the offset backwards.
 */
const UTC_DATE_ONLY_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeZone: "UTC",
});

export const formatDateOnly = (date: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "—";
  const parsed = parse(`${date}T00:00:00.000Z`);
  return parsed === null ? "—" : UTC_DATE_ONLY_FORMAT.format(parsed);
};

/**
 * The `datetime` attribute of a `<time>` element. Returns the ISO string
 * unchanged when it parses, and `undefined` when it does not — an invalid
 * `datetime` is worse than an absent one, because assistive technology reads it
 * as authoritative.
 */
export const toDateTimeAttribute = (iso: string): string | undefined =>
  parse(iso) === null ? undefined : iso;

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

/** `"Showing 1–20 of 63 tasks"` — the live-region copy on the list page. */
export const formatCount = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count.toLocaleString()} ${count === 1 ? singular : plural}`;

/**
 * Truncates on a word boundary, with a real ellipsis. Used in card previews.
 *
 * The clip takes `max + 1` characters, not `max`: with `max` exactly, a string
 * whose word boundary falls *on* the limit loses that whole last word, because
 * the trailing space that would have marked the boundary was the character just
 * cut off. The extra character is only inspected, never emitted.
 *
 * The `0.6` floor is the guard against the opposite failure — a long unbroken
 * token after an early space ("a supercalifragilistic…") would otherwise
 * truncate back to "a".
 */
export const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text;

  const clipped = text.slice(0, max + 1);
  const lastSpace = clipped.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? clipped.slice(0, lastSpace) : clipped.slice(0, max);
  return `${cut.trimEnd()}…`;
};
