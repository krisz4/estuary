import { actorKindOf, type TaskEvent } from "@helpdesk/contracts";
import { formatCount, formatRelative } from "@/lib/formatting";

/**
 * "Since you left" — a quick summary of what happened since the viewer's last
 * visit, computed from the event log's newest page rather than a dedicated
 * request: the page already fetches recent events for the log section, and a
 * few dozen rows is enough to answer "did anything happen" without a second
 * round trip. If the last visit is older than every event loaded, `truncated`
 * says so, and the summary reads as a floor rather than an exact count.
 */
export type SinceYouLeftSummary = {
  /** No stored visit yet — first time here, or storage was cleared. */
  firstVisit: boolean;
  shipped: number;
  /** Transitions out of `needs_qa` to anything but `done`/`deferred` — QA sent it back. */
  sentBack: number;
  decisionsRequested: number;
  actionsRequested: number;
  qaRequested: number;
  /** Distinct `agent:` actors that did anything. */
  activeAgents: string[];
  /**
   * The single `agent:` actor that asked the most decisions/actions, and how
   * many — "claude-code asked 3 questions" reads better than a bare count
   * when one agent clearly did the asking. `null` when nobody asked anything,
   * or when the top spot is a tie (there is no single "the" agent to name).
   */
  topAskingAgent: { actor: string; count: number } | null;
  /** `lastVisitAt` is older than the oldest event this page saw — there may be more than shown. */
  truncated: boolean;
};

export const sinceYouLeftSummary = (
  events: TaskEvent[],
  lastVisitAt: string | null,
): SinceYouLeftSummary => {
  if (lastVisitAt === null) {
    return {
      firstVisit: true,
      shipped: 0,
      sentBack: 0,
      decisionsRequested: 0,
      actionsRequested: 0,
      qaRequested: 0,
      activeAgents: [],
      topAskingAgent: null,
      truncated: false,
    };
  }

  const sinceMs = Date.parse(lastVisitAt);
  const recent = events.filter((event) => Date.parse(event.createdAt) > sinceMs);

  let shipped = 0;
  let sentBack = 0;
  let decisionsRequested = 0;
  let actionsRequested = 0;
  let qaRequested = 0;
  const activeAgents = new Set<string>();
  const askedByAgent = new Map<string, number>();
  const bumpAsked = (actor: string) => askedByAgent.set(actor, (askedByAgent.get(actor) ?? 0) + 1);

  for (const event of recent) {
    if (actorKindOf(event.actor) === "agent") activeAgents.add(event.actor);

    if (event.type === "task.status_changed") {
      const from = typeof event.payload.from === "string" ? event.payload.from : undefined;
      const to = typeof event.payload.to === "string" ? event.payload.to : undefined;
      if (to === "done") shipped += 1;
      else if (to === "needs_user_action") {
        actionsRequested += 1;
        if (actorKindOf(event.actor) === "agent") bumpAsked(event.actor);
      } else if (to === "needs_qa") qaRequested += 1;
      // Same definition `GET /stats/history` uses for a bucket's `sentBack`:
      // out of `needs_qa` to anything but `done`/`deferred`.
      if (from === "needs_qa" && to !== "done" && to !== "deferred" && to !== undefined) sentBack += 1;
    } else if (event.type === "decision.requested") {
      decisionsRequested += 1;
      if (actorKindOf(event.actor) === "agent") bumpAsked(event.actor);
    }
  }

  let topAskingAgent: SinceYouLeftSummary["topAskingAgent"] = null;
  let topCount = 0;
  let tie = false;
  for (const [actor, count] of askedByAgent) {
    if (count > topCount) {
      topCount = count;
      topAskingAgent = { actor, count };
      tie = false;
    } else if (count === topCount && count > 0) {
      tie = true;
    }
  }
  if (tie) topAskingAgent = null;

  const oldestLoaded = events.reduce<number | null>((min, event) => {
    const ts = Date.parse(event.createdAt);
    return min === null || ts < min ? ts : min;
  }, null);

  return {
    firstVisit: false,
    shipped,
    sentBack,
    decisionsRequested,
    actionsRequested,
    qaRequested,
    activeAgents: [...activeAgents],
    topAskingAgent,
    truncated: oldestLoaded !== null && oldestLoaded > sinceMs,
  };
};

/**
 * The one-line "Since you left" sentence for the page's top row — same tone
 * as the floor's `Briefing`: "Since you left 14h ago: 5 shipped, 2 sent back,
 * claude-code asked 3 questions." `null` when there is nothing to say yet
 * (first visit, or a visit with no qualifying events) — the caller falls back
 * to its own first-visit/"nothing new" copy in that case.
 */
export const sinceYouLeftSentence = (summary: SinceYouLeftSummary, lastVisitAt: string | null): string | null => {
  if (summary.firstVisit || lastVisitAt === null) return null;

  const questions = summary.decisionsRequested + summary.actionsRequested;
  const parts: string[] = [];
  if (summary.shipped > 0) parts.push(`${summary.shipped} shipped`);
  if (summary.sentBack > 0) parts.push(`${summary.sentBack} sent back`);
  if (questions > 0) {
    const who = summary.topAskingAgent !== null && summary.topAskingAgent.count === questions
      ? bareActorName(summary.topAskingAgent.actor)
      : null;
    parts.push(who !== null ? `${who} asked ${formatCount(questions, "question")}` : `${formatCount(questions, "question")} asked`);
  }

  if (parts.length === 0) return null;
  return `Since you left ${formatRelative(lastVisitAt)}: ${parts.join(", ")}.`;
};

/** `agent:claude-code` → `claude-code`, for the sentence's inline actor mention. */
const bareActorName = (actor: string): string => actor.replace(/^(agent|human):/, "");
