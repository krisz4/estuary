import {
  ATTENTION_KINDS,
  attentionKindOf,
  type AttentionKind,
  type TaskSummary,
} from "@estuary/contracts";

/**
 * The one grouping the inbox and the map's "Needs you" section both use —
 * `AttentionKind` order, titles, and hints in exactly one place, so a copy
 * edit here shows up in both consumers instead of drifting between two
 * hand-kept copies.
 *
 * `attentionKindOf` (from the contracts, shared with the server's
 * `?attention=true` filter) is the only classifier: a row's group can never
 * disagree with whether the server put it in the attention set at all.
 */
export const ATTENTION_GROUP_META: Record<AttentionKind, { title: string; hint: string }> = {
  decide: { title: "Decide", hint: "An agent asked a question." },
  act: { title: "Act", hint: "A manual step only a person can do." },
  review: { title: "Review", hint: "The work is done — check it." },
  refine: { title: "Refine", hint: "Say what done looks like, and an agent can pick it up." },
  suggested: { title: "Suggested", hint: "Agents filed these; nobody has looked yet." },
  blocked: { title: "Blocked outside", hint: "Waiting on something no task tracks." },
};

export type AttentionGroup = {
  kind: AttentionKind;
  title: string;
  hint: string;
  tasks: TaskSummary[];
};

/**
 * `tasks` partitioned by `attentionKindOf`, in `ATTENTION_KINDS` order, with
 * empty groups omitted. A task the server would not have returned for
 * `?attention=true` (a poll racing a transition) classifies to no group and
 * is simply dropped — the next refetch removes it from view either way.
 */
export const groupByAttentionKind = (tasks: readonly TaskSummary[]): AttentionGroup[] =>
  ATTENTION_KINDS.map((kind) => ({
    kind,
    ...ATTENTION_GROUP_META[kind],
    tasks: tasks.filter((task) => attentionKindOf(task) === kind),
  })).filter((group) => group.tasks.length > 0);
