import {
  type EventsQueryInput,
  type FloorQueryInput,
  type HistoryQueryInput,
  type TaskListQueryInput,
  type TaskStatsQuery,
} from "@estuary/contracts";

/**
 * Every TanStack Query key in the app.
 *
 * **No inline key arrays, ever.** An invalidation written as
 * `["tasks"]` at one call site and `["tasks", "list"]` at another does not
 * fail loudly — it just quietly stops refreshing one of them, and the bug
 * surfaces as "the list is stale after I edit a task" days later. Centralising
 * them makes the hierarchy a fact of the module rather than a convention.
 *
 * The hierarchy is prefix-based, which is what makes partial invalidation work:
 *
 * ```
 * ["tasks"]                          ← tasks.all      invalidates everything below
 *   ["tasks","list"]                 ← tasks.lists()  every list, any filter
 *     ["tasks","list",{…params}]     ← tasks.list()   one filtered page
 *   ["tasks","detail"]               ← tasks.details()
 *     ["tasks","detail",42]          ← tasks.detail()
 *   ["tasks","facets"]               ← tasks.facets()
 *   ["tasks","stats"]                ← tasks.stats()  count per status + inbox badge
 *     ["tasks","stats",{project}]    ← tasks.statsFor() one project scope's counts
 * ["events"]                         ← events.all     the activity feed
 *   ["events",{taskId:42}]           ← events.task()  one task's timeline
 * ```
 *
 * `stats` sits under `tasks.all` because every task write can move a count.
 * `events` does not: it is an append-only log, and a write that did not come
 * from this browser (an agent's) reaches it through polling, not invalidation.
 * Writes from here invalidate it explicitly so the timeline shows the change
 * the user just made without waiting a polling interval.
 *
 * Which prefix to invalidate is a real decision, not a formality. The rule is
 * "the smallest prefix that covers everything the write could have changed":
 *
 * | Write | Prefix | Why |
 * | ----- | ------ | --- |
 * | Comment added/deleted | `detail(id)` + `events` | Comments do not touch `version`, so no list row moved |
 * | Create, or an edit-form save | `all` + `events` | Any field may have changed, including an assignee or project that adds or removes a `facets` entry |
 * | Transition, claim, release, decision answer, dependency change | `lists()` + `details()` + `stats()` + `events` | Can reorder and re-filter every list, and can auto-unblock *other* tasks (so every mounted detail, not one) — but adds no assignee, project, or creator to `facets` |
 * | Delete | `lists()` + `facets()` + `stats()` + `events` | Plus `detail(id)` marked stale with `refetchType: "none"` — see `useDeleteTaskMutation` for why refetching it would be a guaranteed 404 |
 * | Clean up done tasks | `all` + `events` | Bulk delete from the list page, where no deleted task's detail is mounted; also moves the floor's done counts |
 *
 * The workflow row is worth the extra lines rather than folding into `all`: the
 * map keeps a facets observer mounted, so `all` there is a `GET /tasks/facets`
 * per drag that cannot return anything new.
 */
export const queryKeys = {
  tasks: {
    all: ["tasks"] as const,
    lists: () => [...queryKeys.tasks.all, "list"] as const,
    /**
     * The params object is part of the key, so two different filter sets are two
     * different cache entries. TanStack Query hashes it with stable key ordering,
     * so `{page:1,status:"todo"}` and `{status:"todo",page:1}` are one entry.
     */
    list: (params: TaskListQueryInput) => [...queryKeys.tasks.lists(), params] as const,
    details: () => [...queryKeys.tasks.all, "detail"] as const,
    detail: (taskId: number) => [...queryKeys.tasks.details(), taskId] as const,
    facets: () => [...queryKeys.tasks.all, "facets"] as const,
    stats: () => [...queryKeys.tasks.all, "stats"] as const,
    /** Counts for one scope. Under `stats()`, so every existing invalidation covers it. */
    statsFor: (query: TaskStatsQuery) => [...queryKeys.tasks.stats(), query] as const,
    /**
     * `GET /floor` — under `tasks.all` (not its own top-level family), so every
     * existing task-write invalidation (`tasks.all`, `invalidateAfterWorkflowWrite`)
     * refreshes the floor for free — a transition made from the floor's own
     * drawer, or from the detail page, or by an agent whose write we polled into
     * view, all land the same way.
     */
    floor: (query: FloorQueryInput) => [...queryKeys.tasks.all, "floor", query] as const,
  },
  events: {
    all: ["events"] as const,
    task: (taskId: number) => [...queryKeys.events.all, { taskId }] as const,
    /**
     * The Logbook's event log — `order=desc`, paged backwards with `before`.
     * The filter set (project/actor/type/range) is part of the key, same
     * reasoning as `tasks.list()`.
     */
    log: (params: EventsQueryInput) => [...queryKeys.events.all, "log", params] as const,
  },
  history: {
    all: ["history"] as const,
    /** `GET /stats/history` for one scope + range + bucket. */
    query: (params: HistoryQueryInput) => [...queryKeys.history.all, params] as const,
  },
  github: {
    all: ["github"] as const,
    /** `GET /integrations/github` — whether the integration is switched on. */
    status: () => [...queryKeys.github.all, "status"] as const,
    /** `GET /tasks/:taskId/github` — live state of one task's GitHub links. */
    taskStatus: (taskId: number) => [...queryKeys.github.all, "task", taskId] as const,
  },
} as const;

export type QueryKeys = typeof queryKeys;
