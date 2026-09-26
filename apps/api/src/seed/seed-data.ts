import type {
  CommentKind,
  DecisionOption,
  TaskLink,
  TaskPriority,
  TaskStatus,
} from "@helpdesk/contracts";

/**
 * Fixture content for `./index.ts`.
 *
 * Data only — no Prisma, no randomness, no side effects. `index.ts` owns the
 * PRNG, the timeline, and the writes; this file owns *what an AI task manager
 * actually looks like*: three codebases, a few Claude Code agents, and the
 * humans who answer their questions.
 *
 * **Statuses are authored, not drawn.** The helpdesk seed drew statuses from a
 * weight table and had to hunt for a PRNG seed whose realised distribution
 * matched the docs. Here a status is not a label but a history — a
 * `needs_user_decision` task needs a question, a `blocked` one needs a reason
 * and an unfinished blocker, a `done` one went through `needs_qa` — so each
 * template states its status and the content that status requires, and
 * `index.ts` derives the event trail that would have produced it. The PRNG only
 * decides *when* things happened and which working notes an agent left.
 *
 * See `docs/features/Seed_Data.md`.
 */

/* ------------------------------------------------------------------ *
 * Actors
 * ------------------------------------------------------------------ */

/** Canonical `kind:name`, lowercase — `createdBy` / `claimedBy` are exact-match filters. */
export const AGENTS = {
  claudeCode: "agent:claude-code",
  ci: "agent:claude-code-ci",
  nightly: "agent:claude-code-nightly",
} as const;

export const HUMANS = {
  krisz: "human:krisz",
  dana: "human:dana",
  marco: "human:marco",
  lena: "human:lena",
} as const;

/** Who claims a task that does not name its `worker`. */
export const DEFAULT_WORKER = AGENTS.claudeCode;
/** Who reviews, answers, and defers when a template does not say. */
export const DEFAULT_REVIEWER = HUMANS.krisz;

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

export const PROJECTS = ["helpdesk", "billing-service", "mobile-app"] as const;
export type SeedProject = (typeof PROJECTS)[number];

/** Where generated PR / branch links point. */
export const GITHUB_ORG_URL = "https://github.com/example-org";

/**
 * First PR number per repository. A task's PR is `base + its template index`,
 * so numbers are stable across runs and never collide within a repository.
 */
export const PR_NUMBER_BASE: Record<SeedProject, number> = {
  helpdesk: 180,
  "billing-service": 612,
  "mobile-app": 347,
};

/* ------------------------------------------------------------------ *
 * Template shape
 * ------------------------------------------------------------------ */

export interface SeedDecisionTemplate {
  question: string;
  options: DecisionOption[];
  recommendedOption?: string;
  context?: string;
}

export interface SeedAnsweredDecisionTemplate extends SeedDecisionTemplate {
  choice?: string;
  note?: string;
  answeredBy: string;
}

export interface SeedCommentTemplate {
  author: string;
  kind: CommentKind;
  body: string;
  /**
   * `start` — right after the task is filed, before anything else happens.
   * `end` (default) — after the task reached its current status.
   */
  at?: "start" | "end";
}

export interface SeedTaskTemplate {
  /** Stable handle for `parent` / `dependsOn`, and the tail of the idempotency key. */
  key: string;
  title: string;
  description: string;
  project: SeedProject | null;
  status: TaskStatus;
  priority: TaskPriority;
  createdBy: string;
  /** Approximate age. `index.ts` adds up to ±0.35 days of jitter. */
  daysAgo: number;
  /** Who claims and works it. Default `DEFAULT_WORKER`. */
  worker?: string;
  /** Who moves it to `done`, defers it, or sends it back from QA. Default `DEFAULT_REVIEWER`. */
  reviewer?: string;
  /** Default: the worker if the task was ever started, otherwise unassigned. */
  assignee?: string | null;
  /** Required for anything that passes through `todo`. */
  acceptanceCriteria?: string;
  /**
   * The note carried by the transition into the current status — the reason,
   * instructions, or summary that becomes `statusNote`. Required for
   * `needs_refinement`, `blocked`, `needs_user_action`, `needs_qa`, `deferred`;
   * optional for `done`. (`needs_user_decision` uses the decision's question.)
   */
  statusNote?: string;
  /** `done` only: the summary it was handed to QA with. */
  qaSummary?: string;
  /** `done` only: sent back from QA once with this `qa_feedback` comment… */
  qaFeedback?: string;
  /** …and re-submitted with this summary. */
  qaResubmit?: string;
  /** Default for `needs_qa` / `done`: a generated PR + branch pair. */
  links?: TaskLink[];
  parent?: string;
  /** Blockers. For a `blocked` task these arrive with the `blocked` transition (`blockedBy`). */
  dependsOn?: string[];
  /** `needs_user_decision` only: the open question. */
  decision?: SeedDecisionTemplate;
  /** A question asked and answered earlier in the task's life; the task has since moved on. */
  answeredDecision?: SeedAnsweredDecisionTemplate;
  /** `in_progress` only. `expired` = the agent crashed and its lease lapsed. Default `live`. */
  claim?: "live" | "expired";
  comments?: SeedCommentTemplate[];
  /**
   * Free-form tags, lowercase slugs (`labelSchema`). Not every task needs one —
   * this seed reaches for a workspace label (`web`, `api`, `contracts`, `mcp`,
   * `db`, `docs`) on `helpdesk`-project tasks, since that project mirrors this
   * very monorepo, and a kind label (`bug`, `flaky-test`, `perf`) wherever the
   * title says so, on any project.
   */
  labels?: string[];
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

/**
 * One template per task. Order here is irrelevant — `index.ts` sorts by the
 * generated `createdAt` so task numbers run chronologically — but a template's
 * index feeds its PR number, so appending is safe and reordering renumbers PRs.
 */
export const TASK_TEMPLATES: readonly SeedTaskTemplate[] = [
  /* ---------------------------- helpdesk ---------------------------- */
  {
    key: "mcp-server",
    title: "Expose the task API as an MCP server",
    description:
      "Claude Code sessions should drive the board through MCP tools instead of hand-written curl calls. New workspace `apps/mcp` wrapping the REST API; the subtasks split the tool groups so they can be picked up in parallel.",
    project: "helpdesk",
    status: "in_progress",
    priority: "high",
    createdBy: HUMANS.krisz,
    daysAgo: 34,
    acceptanceCriteria:
      "- `apps/mcp` builds and starts with `pnpm --filter @helpdesk/mcp start`\n- Every tool maps to exactly one REST endpoint and forwards X-Actor\n- Errors come back as the API's `error.code`, not a stack trace\n- Subtasks are done or explicitly deferred",
    comments: [
      {
        author: HUMANS.krisz,
        kind: "note",
        body: "Split this into three subtasks so they can run in parallel. Keep this one for the package skeleton and the shared HTTP client.",
        at: "start",
      },
    ],
    labels: ["mcp"],
  },
  {
    key: "mcp-claim-tools",
    title: "MCP: tasks_next, claim, heartbeat and release tools",
    description:
      "The four tools an agent needs to take work off the queue and hold it. The heartbeat belongs in the agent loop, not in each tool call.",
    project: "helpdesk",
    status: "done",
    priority: "high",
    createdBy: AGENTS.claudeCode,
    daysAgo: 30,
    parent: "mcp-server",
    acceptanceCriteria:
      "- `tasks_next` returns `{ task: null }` as a normal result, not an error\n- `heartbeat` and `release` surface NOT_CLAIM_HOLDER verbatim\n- Integration test drives all four against a temp API",
    qaSummary:
      "Added the four tools plus an integration test that boots the API on a random port. `tasks_next` with nothing available returns a normal empty result.",
    statusNote:
      "Tried it from a real Claude Code session; claims and releases show up in the events feed.",
    labels: ["mcp"],
  },
  {
    key: "mcp-decision-tools",
    title: "MCP: request_decision and answer_decision tools",
    description:
      "Agents need to park a task on a question with options instead of burying it in a comment. `answer_decision` is mostly for tests; humans answer in the web app.",
    project: "helpdesk",
    status: "needs_qa",
    priority: "medium",
    createdBy: AGENTS.claudeCode,
    daysAgo: 26,
    parent: "mcp-server",
    acceptanceCriteria:
      "- `request_decision` validates options with the contracts schema before calling the API\n- `recommendedOption` must be one of the labels\n- Answering moves the task back to todo",
    statusNote:
      "Both tools added, reusing `decisionRequestSchema` from contracts so validation errors match the API's. To verify: run `pnpm --filter @helpdesk/mcp test`, then request a decision from a Claude Code session and answer it on the board.",
    comments: [
      {
        author: HUMANS.dana,
        kind: "note",
        body: "Will review tomorrow morning — I want to try it against the inbox page at the same time.",
      },
    ],
    labels: ["mcp"],
  },
  {
    key: "mcp-docs",
    title: "Document the Claude Code MCP setup in Agent_Integration.md",
    description:
      "Once the decision tools land, write the setup page: registering the server in `.mcp.json`, the X-Actor naming convention, and the recommended agent loop (next → heartbeat → needs_qa).",
    project: "helpdesk",
    status: "todo",
    priority: "low",
    createdBy: AGENTS.claudeCode,
    daysAgo: 20,
    parent: "mcp-server",
    dependsOn: ["mcp-decision-tools"],
    acceptanceCriteria:
      "- Copy-pasteable `.mcp.json` snippet\n- Explains why agents stop at needs_qa\n- Linked from docs/features/README.md",
    labels: ["mcp", "docs"],
  },
  {
    key: "stats-project-filter",
    title: "Accept a project filter on GET /tasks/stats",
    description:
      "The lane counts on the board ignore the project picker, so the header says 14 in progress while the filtered board shows 3.",
    project: "helpdesk",
    status: "in_progress",
    priority: "medium",
    createdBy: HUMANS.dana,
    daysAgo: 9,
    worker: HUMANS.dana,
    acceptanceCriteria:
      "- `project` is repeatable, same as on GET /tasks\n- `needsAttention` respects the filter too\n- Board header counts match the visible cards",
    comments: [
      {
        author: HUMANS.dana,
        kind: "note",
        body: "Taking this one myself — it's a where clause and a test. Web side after.",
      },
    ],
    labels: ["api"],
  },
  {
    key: "board-dnd-slow-network",
    title: "Board drag-and-drop drops the card on slow networks",
    description:
      "On a throttled connection (Chrome 'Slow 4G') dragging a card to another lane makes it vanish until the next refetch. Looks like the optimistic update is rolled back before the server answers.",
    project: "helpdesk",
    status: "in_progress",
    claim: "expired",
    priority: "high",
    createdBy: HUMANS.marco,
    daysAgo: 18,
    acceptanceCriteria:
      "- Card stays in the target lane while the transition is in flight\n- A rejected transition puts it back with a toast carrying the server's message\n- Playwright test with network throttling",
    comments: [
      {
        author: AGENTS.claudeCode,
        kind: "progress",
        body: "The rollback fires from onSettled instead of onError. Fix is on the branch; still writing the throttled Playwright test.",
      },
    ],
    labels: ["web", "bug"],
  },
  {
    key: "events-cursor-same-ms",
    title: "Events feed skips rows when two writes share a millisecond",
    description:
      "The CI agent's poller missed a status change: the cursor was built from `createdAt`, and two events written in the same transaction share a timestamp.",
    project: "helpdesk",
    status: "done",
    priority: "urgent",
    createdBy: AGENTS.ci,
    daysAgo: 45,
    worker: AGENTS.ci,
    acceptanceCriteria:
      "- Cursor is the event id, never a timestamp\n- Regression test writes two events in one transaction and reads them across a page boundary",
    answeredDecision: {
      question: "Should the events cursor be the id alone, or a (createdAt, id) pair?",
      options: [
        {
          label: "Cursor on id",
          description:
            "SQLite assigns ids in commit order. Simplest, and the cursor stays an integer.",
        },
        {
          label: "Cursor on (createdAt, id)",
          description:
            "Survives a move to a database where ids are not monotonic, at the cost of an opaque string cursor.",
        },
      ],
      recommendedOption: "Cursor on id",
      context:
        "SQLite serialises writers, so autoincrement ids are strictly increasing in commit order. The contract already documents `after` as an event id.",
      choice: "Cursor on id",
      note: "If we ever leave SQLite we revisit this anyway.",
      answeredBy: HUMANS.krisz,
    },
    qaSummary:
      "The feed now pages strictly by id. Added the two-events-one-transaction regression test; it fails on main.",
    labels: ["api", "db", "bug"],
  },
  {
    key: "inbox-badge-needs-qa",
    title: "Inbox badge count ignores needs_qa tasks",
    description:
      "The badge counts decisions and user actions but not tasks waiting for QA, so finished agent work sits unnoticed for days.",
    project: "helpdesk",
    status: "done",
    priority: "medium",
    createdBy: HUMANS.dana,
    daysAgo: 52,
    reviewer: HUMANS.dana,
    acceptanceCriteria:
      "- Badge uses `needsAttention` from GET /tasks/stats\n- needs_qa tasks appear in the inbox list",
    qaSummary:
      "The badge now reads `needsAttention`, which already included needs_qa. The inbox query uses HUMAN_ATTENTION_STATUSES instead of its own list.",
    statusNote: "Checked on staging: badge shows 5, inbox lists 5.",
    labels: ["web", "api"],
  },
  {
    key: "actor-header-validation",
    title: "Reject malformed X-Actor headers with VALIDATION_ERROR",
    description:
      "A header like `Claude Code` (space, capitals, no kind) was stored verbatim and then never matched the createdBy filter.",
    project: "helpdesk",
    status: "done",
    priority: "high",
    createdBy: AGENTS.claudeCode,
    daysAgo: 55,
    acceptanceCriteria:
      '- Header is trimmed and lowercased before validation\n- Invalid values return 422 with details["X-Actor"]\n- `system:` is rejected from clients',
    qaSummary:
      "Actor parsing moved into middleware using `actorSchema` from contracts. Route tests cover the three bad shapes from the description plus `system:taskmanager`.",
    labels: ["api"],
  },
  {
    key: "api-token-gate",
    title: "Optional bearer token gate for self-hosted deployments",
    description:
      "The demo server on the VPS is reachable from the internet. Add an optional shared token (API_TOKEN) checked on every /api/v1 route; /health and /docs stay open.",
    project: "helpdesk",
    status: "needs_user_action",
    priority: "high",
    createdBy: HUMANS.krisz,
    daysAgo: 22,
    acceptanceCriteria:
      "- No API_TOKEN set → behaviour unchanged\n- Wrong or missing token → 401 UNAUTHORIZED in the standard envelope\n- Documented in ENVIRONMENT_VARIABLES.md",
    statusNote:
      "The code is merged. The last step needs someone with access to the VPS: generate a token with `openssl rand -hex 32`, add `API_TOKEN=<value>` to /etc/helpdesk/api.env, restart with `systemctl restart helpdesk-api`, and put the same value in the MCP server's env. I have no access to that host from this sandbox.",
    links: [{ label: "PR #189", url: `${GITHUB_ORG_URL}/helpdesk/pull/189` }],
    labels: ["api"],
  },
  {
    key: "verify-task-migration",
    title: "Verify the ticket-to-task migration on a copy of production data",
    description:
      "The rename migration rewrites statuses and backfills createdBy from requester emails. It passes on seed data; it has not run against the real database.",
    project: "helpdesk",
    status: "needs_user_action",
    priority: "urgent",
    createdBy: AGENTS.claudeCode,
    daysAgo: 6,
    acceptanceCriteria:
      "- Row counts match before and after for Task and Comment\n- No task ends up with a status outside TASK_STATUSES\n- Every migrated task has a task.created event",
    statusNote:
      "Please restore last night's backup to a scratch file, run `DATABASE_URL=file:/tmp/prod-copy.db pnpm --filter @helpdesk/api db:deploy`, then paste the output of `sqlite3 /tmp/prod-copy.db \"SELECT status, count(*) FROM Task GROUP BY status\"` here. I can't read production backups.",
    labels: ["db"],
  },
  {
    key: "withdrawn-decisions-timeline",
    title: "Show withdrawn decisions in the task timeline",
    description:
      "When a task is dragged out of needs_user_decision the open question is withdrawn, and the detail page no longer shows it was ever asked.",
    project: "helpdesk",
    status: "backlog",
    priority: "low",
    createdBy: HUMANS.dana,
    daysAgo: 15,
    labels: ["web"],
  },
  {
    key: "board-dark-mode",
    title: "Board columns are unreadable in dark mode",
    description:
      "Lane headers use slate-100 text on slate-50 in dark mode. The waiting lane is the worst — the amber tint makes the counts invisible.",
    project: "helpdesk",
    status: "todo",
    priority: "medium",
    createdBy: HUMANS.marco,
    daysAgo: 12,
    acceptanceCriteria:
      "- Lane headers and counts pass WCAG AA contrast in both themes\n- No hard-coded colours left in the board components",
    answeredDecision: {
      question:
        "Should the board reuse the app's semantic colour tokens for its lanes, or get its own palette?",
      options: [
        {
          label: "Reuse the semantic tokens",
          description: "Lanes match the status badges everywhere else; one place to change.",
        },
        {
          label: "Board-specific palette",
          description: "More distinct lanes, but a second set of colours to keep accessible.",
        },
      ],
      recommendedOption: "Reuse the semantic tokens",
      context:
        "The badges already pass AA in both themes. The board is the only screen that defines its own colours.",
      choice: "Reuse the semantic tokens",
      answeredBy: HUMANS.marco,
    },
    labels: ["web"],
  },
  {
    key: "agents-may-complete-ci",
    title: "Let the CI agent close dependency-bump tasks without QA",
    description:
      "Dependency bumps pile up in needs_qa. The CI agent already runs the full suite; a human clicking done adds nothing for patch releases.",
    project: "helpdesk",
    status: "needs_user_decision",
    priority: "medium",
    createdBy: AGENTS.claudeCode,
    daysAgo: 10,
    acceptanceCriteria:
      "- The chosen policy is enforced server-side\n- Documented in Task_Workflow_API.md",
    decision: {
      question: "Should agents be allowed to move dependency-bump tasks straight to done?",
      options: [
        {
          label: "Keep it off for everyone",
          description: "Every task goes through a human. Simplest to reason about.",
        },
        {
          label: "Allow agent:claude-code-ci only",
          description: "An allowlist of actors in AGENTS_MAY_COMPLETE instead of a boolean.",
        },
        {
          label: "Per-project allowlist",
          description: "More flexible, but a new configuration surface.",
        },
      ],
      recommendedOption: "Allow agent:claude-code-ci only",
      context:
        "There are 11 bump tasks in needs_qa right now, all green in CI. The actor is self-declared, so this is a convenience rule, not a security boundary.",
    },
    labels: ["api", "mcp"],
  },
  {
    key: "openapi-examples",
    title: "Add request examples to every workflow endpoint in the OpenAPI spec",
    description:
      "Agents reading /docs guess payload shapes for /transition. One example per target status would save a round of VALIDATION_ERRORs.",
    project: "helpdesk",
    status: "backlog",
    priority: "low",
    createdBy: AGENTS.claudeCode,
    daysAgo: 28,
    labels: ["api", "docs"],
  },
  {
    key: "events-retention",
    title: "Decide on a retention policy for the events table",
    description:
      "Events are never deleted. At current volume that is fine; at some point it won't be.",
    project: "helpdesk",
    status: "deferred",
    priority: "low",
    createdBy: HUMANS.krisz,
    daysAgo: 48,
    statusNote:
      "About 40k rows after two months and the feed query is still an index range scan. Revisit when the table passes a million rows or a feed request takes over 50 ms.",
    labels: ["db"],
  },
  {
    key: "search-acceptance-criteria",
    title: "Search should match acceptance criteria as well as title and description",
    description:
      "Searching for 'VIES' misses the checkout task because the word only appears in its acceptance criteria.",
    project: "helpdesk",
    status: "needs_refinement",
    priority: "medium",
    createdBy: HUMANS.dana,
    daysAgo: 8,
    statusNote:
      "Unclear what should happen to ordering: `q` has no relevance ranking today, results follow the chosen sort. Should criteria-only matches sit in the same list, or be flagged as weaker? And should statusNote be searched too?",
    labels: ["api", "db"],
  },
  {
    key: "e2e-board-flake",
    title: "Playwright: board drag test flakes on CI about 1 run in 15",
    description:
      "`board.spec.ts › moves a card between lanes` fails intermittently with the card missing from the target lane. Same symptom as the slow-network drag-and-drop bug.",
    project: "helpdesk",
    status: "blocked",
    priority: "high",
    createdBy: AGENTS.ci,
    daysAgo: 14,
    worker: AGENTS.ci,
    dependsOn: ["board-dnd-slow-network"],
    acceptanceCriteria: "- 50 consecutive CI runs green\n- No retries added to hide it",
    statusNote:
      "Same root cause as the slow-network drag-and-drop bug (optimistic rollback in onSettled). Fixing the test before the app would paper over it.",
    labels: ["web", "flaky-test"],
  },
  {
    key: "release-claims-on-exit",
    title: "Release claims when an agent session exits cleanly",
    description:
      "A session that ends normally leaves its claim to expire on its own, so the task sits idle for the rest of the lease. The MCP server could release on shutdown.",
    project: "helpdesk",
    status: "backlog",
    priority: "medium",
    createdBy: AGENTS.claudeCode,
    daysAgo: 4,
    labels: ["mcp"],
  },
  {
    key: "heartbeat-guidance",
    title: "Heartbeat interval guidance for long-running agents",
    description:
      "Document how often an agent should heartbeat and what to do when a heartbeat returns NOT_CLAIM_HOLDER.",
    project: "helpdesk",
    status: "done",
    priority: "low",
    createdBy: HUMANS.krisz,
    daysAgo: 38,
    acceptanceCriteria:
      "- Recommends a third of CLAIM_LEASE_MINUTES\n- Explains that losing the claim means stop and re-read, not retry",
    qaSummary:
      "Added a Claims section to Agent_Integration.md with the interval rule and the NOT_CLAIM_HOLDER recovery steps.",
    labels: ["mcp", "docs"],
  },
  {
    key: "task-templates",
    title: "Task templates for recurring chores",
    description:
      "Weekly dependency bumps, monthly secret-rotation reminders. A template would pre-fill title, project and acceptance criteria.",
    project: "helpdesk",
    status: "backlog",
    priority: "low",
    createdBy: HUMANS.marco,
    daysAgo: 24,
    labels: ["api", "web"],
  },
  {
    key: "comment-kind-filter",
    title: "Filter the thread by comment kind",
    description:
      "Agent progress notes drown out the human discussion on long tasks. A toggle to hide `progress` comments would make threads readable again.",
    project: "helpdesk",
    status: "todo",
    priority: "medium",
    createdBy: HUMANS.dana,
    daysAgo: 16,
    acceptanceCriteria:
      "- A toggle on the detail page hides progress comments\n- The choice persists per browser, not in the URL\n- qa_feedback is always shown",
    labels: ["web", "api"],
  },

  /* ------------------------- billing-service ------------------------ */
  {
    key: "pdf-offload",
    title: "Move invoice PDF rendering off the request path",
    description:
      "POST /invoices/:id/finalize renders the PDF inline and p95 is 3.8 s. Render in a background worker and return immediately.",
    project: "billing-service",
    status: "needs_qa",
    priority: "high",
    createdBy: HUMANS.krisz,
    daysAgo: 42,
    acceptanceCriteria:
      "- finalize returns in under 300 ms at p95\n- The PDF appears within 30 s of finalizing\n- Subtasks done",
    statusNote:
      "Finalize now enqueues a render job and returns 202. With the retry subtask merged, p95 on staging is 140 ms and every test invoice rendered within 12 s. To verify: finalize an invoice on staging and watch render_jobs.",
    comments: [
      {
        author: HUMANS.dana,
        kind: "note",
        body: "Looks good on staging. Holding off on done until the August backfill has run — that's the first real load on the worker.",
      },
    ],
    labels: ["perf"],
  },
  {
    key: "pdf-render-jobs",
    title: "Add a render_jobs table and worker loop",
    description:
      "A small Postgres-backed queue: a jobs table with status, attempts and locked_until, and a worker that polls with SKIP LOCKED.",
    project: "billing-service",
    status: "done",
    priority: "high",
    createdBy: AGENTS.claudeCode,
    daysAgo: 40,
    parent: "pdf-offload",
    acceptanceCriteria:
      "- Two workers never render the same invoice\n- A crashed worker's job is picked up after locked_until\n- The migration ships with the change",
    qaSummary:
      "Added render_jobs with a partial index on pending rows and a worker using FOR UPDATE SKIP LOCKED. The test starts two workers against one job and asserts a single render.",
    labels: ["perf"],
  },
  {
    key: "pdf-render-retry",
    title: "Retry failed PDF renders with exponential backoff",
    description:
      "Renders fail whenever the font CDN hiccups. Retry with backoff instead of marking the job failed on the first error.",
    project: "billing-service",
    status: "done",
    priority: "medium",
    createdBy: AGENTS.claudeCode,
    daysAgo: 36,
    parent: "pdf-offload",
    reviewer: HUMANS.dana,
    acceptanceCriteria:
      "- Retries up to 8 times with exponential backoff\n- The final failure alerts #billing-alerts\n- Backoff has a ceiling",
    qaSummary: "Retries with 2^attempt minute backoff and alerts on the final failure.",
    qaFeedback:
      "Backoff has no ceiling in the code — attempt 8 waits over four hours, which the acceptance criteria rule out. Cap it at one hour and add a test for the cap.",
    qaResubmit:
      "Capped the backoff at 60 minutes and added a test that walks attempts 1–8. Alerting unchanged.",
  },
  {
    key: "pdf-backfill-august",
    title: "Backfill missing PDFs for August invoices",
    description:
      "312 August invoices were finalized while rendering was failing and have no PDF. Enqueue a render job for each.",
    project: "billing-service",
    status: "todo",
    priority: "medium",
    createdBy: AGENTS.claudeCode,
    daysAgo: 21,
    parent: "pdf-offload",
    dependsOn: ["pdf-render-jobs"],
    acceptanceCriteria:
      "- The script is idempotent (skips invoices that already have a PDF)\n- Runs in batches of 50 so it doesn't starve live renders\n- Zero missing PDFs afterwards",
  },
  {
    key: "refund-idempotency",
    title: "Idempotency keys for POST /refunds",
    description:
      "A client retry after a timeout issued the same €480 refund twice last week. Refunds must accept an Idempotency-Key header and replay the first response.",
    project: "billing-service",
    status: "in_progress",
    priority: "urgent",
    createdBy: HUMANS.dana,
    daysAgo: 11,
    worker: AGENTS.ci,
    acceptanceCriteria:
      "- Same key + same body → the original response, no second refund\n- Same key + different body → 422\n- Keys expire after 24 hours",
    answeredDecision: {
      question: "Where should refund idempotency keys be stored?",
      options: [
        {
          label: "Postgres table",
          description:
            "Same transaction as the refund row, so a key can never exist without its refund. Needs a cleanup job.",
        },
        {
          label: "Redis with 24 h TTL",
          description: "Expiry is free, but the key and the refund commit separately.",
        },
      ],
      recommendedOption: "Postgres table",
      context:
        "The double refund happened because the first request committed and its response was lost. Anything that can commit separately from the refund reopens that window.",
      choice: "Postgres table",
      note: "Add the cleanup to the existing nightly job rather than a new one.",
      answeredBy: HUMANS.dana,
    },
    labels: ["bug"],
  },
  {
    key: "billing-prisma-upgrade",
    title: "Upgrade Prisma to 6.19 in billing-service",
    description:
      "Routine bump from 6.16. The changelog mentions a fix for the interactive-transaction timeout we work around in the refund service.",
    project: "billing-service",
    status: "in_progress",
    claim: "expired",
    priority: "low",
    createdBy: AGENTS.ci,
    daysAgo: 7,
    worker: AGENTS.ci,
    acceptanceCriteria:
      "- Full test suite green\n- The workaround in refund.service.ts is removed if the fix covers it",
    comments: [
      {
        author: AGENTS.ci,
        kind: "progress",
        body: "Generated client diff is clean. Two snapshot tests changed because error messages now include the model name — updating them next.",
      },
    ],
  },
  {
    key: "stripe-webhook-secret",
    title: "Verify Stripe webhook signatures with the rotated secret",
    description:
      "The signing secret appeared in a log line that was shipped to a vendor. It has to be rotated, and the handler must accept both secrets during the switch.",
    project: "billing-service",
    status: "needs_user_action",
    priority: "urgent",
    createdBy: HUMANS.krisz,
    daysAgo: 3,
    acceptanceCriteria:
      "- The handler accepts either secret while both are configured\n- The old secret is removed after rotation\n- No secret appears in logs (a test asserts it)",
    statusNote:
      "Dual-secret verification is merged and deployed. This now needs a human with Stripe dashboard access: Developers → Webhooks → billing-prod → Roll secret (expire the old one in 24 h), then set STRIPE_WEBHOOK_SECRET_NEXT in the production secret store and redeploy. Reply here when done and I'll remove the old-secret path.",
    links: [{ label: "PR #640", url: `${GITHUB_ORG_URL}/billing-service/pull/640` }],
  },
  {
    key: "proration-off-by-one",
    title: "Proration is off by one day on mid-cycle upgrades",
    description:
      "A customer upgrading on day 15 of a 30-day cycle is charged for 16 days of the new plan. Support has had four tickets about it this month.",
    project: "billing-service",
    status: "needs_user_decision",
    priority: "high",
    createdBy: HUMANS.dana,
    daysAgo: 13,
    acceptanceCriteria:
      "- The chosen rule matches what Stripe shows on the upcoming invoice\n- Unit tests for upgrades on the first, a middle, and the last day of a cycle",
    decision: {
      question: "Which plan should the day of an upgrade be billed on?",
      options: [
        {
          label: "Old plan",
          description: "The upgrade day stays on the old plan; the new plan starts the next day.",
        },
        {
          label: "New plan",
          description:
            "Matches Stripe's upcoming-invoice preview, which is what customers compare against.",
        },
        {
          label: "Prorate by the second",
          description:
            "Exact, but invoices show amounts like €13.47 that support will be asked about.",
        },
      ],
      recommendedOption: "New plan",
      context:
        "Our code counts the upgrade day on both plans, which is the off-by-one. Any option fixes it; they differ in what the customer sees. Stripe's preview puts the whole day on the new plan.",
    },
    labels: ["bug"],
  },
  {
    key: "jpy-rounding",
    title: "Invoice total and line items disagree for JPY",
    description:
      "Nightly reconciliation flagged 23 JPY invoices where the total is ¥1 more than the sum of the lines. We round in minor units, and JPY has none.",
    project: "billing-service",
    status: "needs_user_decision",
    priority: "high",
    createdBy: AGENTS.ci,
    daysAgo: 5,
    worker: AGENTS.ci,
    acceptanceCriteria:
      "- Reconciliation reports zero JPY mismatches\n- Existing invoices are not rewritten",
    decision: {
      question: "How should amounts in zero-decimal currencies be rounded?",
      options: [
        {
          label: "Round each line item",
          description:
            "The total is the sum of rounded lines. Small change; matches how the PDF reads.",
        },
        {
          label: "Round the total only",
          description: "Lines may visibly fail to add up on the PDF.",
        },
        {
          label: "Store per-currency minor units",
          description: "The correct model; touches every money column and the API.",
        },
      ],
      recommendedOption: "Round each line item",
      context:
        "Per-currency minor units is the right long-term model but a multi-week migration. Rounding per line fixes all 23 invoices and can ship this week.",
    },
    labels: ["bug"],
  },
  {
    key: "dunning-emails",
    title: "Dunning email sequence for failed card payments",
    description:
      "Failed renewals just mark the subscription past_due. Send reminders on day 1, 3 and 7, then cancel on day 10.",
    project: "billing-service",
    status: "blocked",
    priority: "high",
    createdBy: HUMANS.krisz,
    daysAgo: 19,
    dependsOn: ["postmark-provider"],
    acceptanceCriteria:
      "- Emails go through the transactional provider, not SMTP\n- A successful retry stops the sequence\n- Each email has a one-click update-card link",
    statusNote:
      "Templates and the scheduler are on the branch. Sending needs the Postmark integration, which isn't built yet — a temporary SMTP path would mean doing the unsubscribe handling twice.",
  },
  {
    key: "postmark-provider",
    title: "Wire Postmark as the transactional email provider",
    description:
      "Replace the SMTP relay for transactional mail. Needed by dunning, receipts and the password reset flow.",
    project: "billing-service",
    status: "todo",
    priority: "high",
    createdBy: HUMANS.krisz,
    daysAgo: 20,
    acceptanceCriteria:
      "- Server token read from POSTMARK_TOKEN\n- Bounces and spam complaints recorded via webhook\n- Local dev uses Postmark's test token, never real sends",
  },
  {
    key: "vat-validation-checkout",
    title: "Validate EU VAT numbers against VIES at checkout",
    description:
      "B2B customers can enter any string as a VAT number and get reverse-charge invoices. Validate against VIES before applying reverse charge.",
    project: "billing-service",
    status: "blocked",
    priority: "medium",
    createdBy: AGENTS.claudeCode,
    daysAgo: 17,
    dependsOn: ["vies-client"],
    acceptanceCriteria:
      "- An invalid number is a checkout error on the field\n- A VIES outage accepts the number and flags the invoice for review\n- No reverse charge without a validated number",
    statusNote:
      "Needs the VIES client, which is in QA. Wiring it into checkout before that lands would mean reviewing the same timeout handling twice.",
  },
  {
    key: "vies-client",
    title: "VIES client with a 3 s timeout and cached results",
    description:
      "Client for the EU VIES service. It is slow and goes down most Sunday nights, so results need caching and a hard timeout.",
    project: "billing-service",
    status: "needs_qa",
    priority: "medium",
    createdBy: AGENTS.claudeCode,
    daysAgo: 18,
    acceptanceCriteria:
      "- Times out at 3 s with a typed error\n- Valid results cached 24 h, invalid ones 1 h\n- Contract test against the VIES test endpoint",
    statusNote:
      "Client, cache and typed errors are done. The contract test hits VIES's test service and is skipped in CI unless VIES_CONTRACT=1. To verify: run it once with the flag and check for a cache hit on the second call.",
    comments: [
      {
        author: HUMANS.dana,
        kind: "note",
        body: "Reviewing today. One question up front: are we caching by the normalised number? 'DE 123' and 'de123' should be one entry.",
      },
      {
        author: AGENTS.claudeCode,
        kind: "note",
        body: "Yes — numbers are uppercased and stripped of spaces and dots before the cache lookup. There's a test for exactly that pair.",
      },
    ],
  },
  {
    key: "coupon-stacking-race",
    title: "Coupons stack when applied from two browser tabs",
    description:
      "Applying the same single-use coupon in two tabs at once applies it twice. A customer reported it with a screenshot of a 100% discount.",
    project: "billing-service",
    status: "done",
    priority: "urgent",
    createdBy: HUMANS.dana,
    daysAgo: 50,
    reviewer: HUMANS.dana,
    acceptanceCriteria:
      "- Redemption is a conditional update, not read-then-write\n- Concurrency test with two parallel applies\n- Affected invoices listed for finance",
    qaSummary:
      "Redemption is now an UPDATE … WHERE redeemed_at IS NULL with a row-count check. The test fires two applies in parallel and exactly one wins. Three affected invoices are listed in the PR.",
    statusNote: "Finance has the three invoices and is handling them.",
    labels: ["bug"],
  },
  {
    key: "gap-free-invoice-numbers",
    title: "Invoice numbers must be gap-free per legal entity",
    description:
      "The auditors flagged gaps in our invoice numbers. We use one global sequence, and failed finalizations burn numbers.",
    project: "billing-service",
    status: "needs_refinement",
    priority: "high",
    createdBy: HUMANS.marco,
    daysAgo: 10,
    statusNote:
      "Gap-free per entity per calendar year, or per entity forever? German and French rules differ, and the description doesn't say which entities we invoice from. Also: do voided invoices keep their number?",
    labels: ["bug"],
  },
  {
    key: "usage-metering",
    title: "Usage-based pricing for API calls",
    description:
      "Sales wants a metered plan. Needs per-account daily aggregation of API calls and a Stripe metered price. Big — split it before anyone starts.",
    project: "billing-service",
    status: "backlog",
    priority: "medium",
    createdBy: HUMANS.krisz,
    daysAgo: 58,
  },
  {
    key: "invoice-list-slow",
    title: "GET /invoices takes 4 s for accounts with 10k invoices",
    description:
      "The endpoint counts every invoice for the pagination meta on each request, and the count is a full scan. Flagged by the CI agent's performance check.",
    project: "billing-service",
    status: "done",
    priority: "high",
    createdBy: AGENTS.ci,
    daysAgo: 33,
    worker: AGENTS.ci,
    acceptanceCriteria:
      "- p95 under 200 ms for the 10k-invoice fixture account\n- Pagination meta unchanged",
    qaSummary:
      "Added a composite index on (account_id, issued_at) and the count now uses it. Fixture account: 4.1 s → 38 ms at p95.",
    labels: ["perf"],
  },
  {
    key: "remove-paypal-express",
    title: "Remove the legacy PayPal Express integration",
    description:
      "PayPal Express was replaced by the checkout SDK two years ago. The old code path is still live for customers who never migrated.",
    project: "billing-service",
    status: "deferred",
    priority: "low",
    createdBy: HUMANS.dana,
    daysAgo: 46,
    reviewer: HUMANS.dana,
    statusNote:
      "Eleven customers still pay through it. Revisit after the migration email goes out in Q4 — removing it now would fail their renewals.",
  },
  {
    key: "balance-adjustment-audit",
    title: "Audit log for manual balance adjustments",
    description:
      "Support can credit an account from the admin panel and nothing records who did it or why.",
    project: "billing-service",
    status: "backlog",
    priority: "high",
    createdBy: HUMANS.dana,
    daysAgo: 27,
    assignee: HUMANS.dana,
  },
  {
    key: "webhook-replay-test-clock",
    title: "Webhook replay test depends on wall-clock time",
    description:
      "`replays events older than 5 minutes` fails when CI runs just after midnight UTC. The test builds its timestamps from Date.now().",
    project: "billing-service",
    status: "done",
    priority: "low",
    createdBy: AGENTS.ci,
    daysAgo: 29,
    worker: AGENTS.ci,
    acceptanceCriteria:
      "- The test uses a fake clock\n- No other test in the file reads the real clock",
    qaSummary:
      "Switched the file to vi.useFakeTimers with a pinned date. Ran it 200 times under a shifted TZ; all green.",
    labels: ["flaky-test"],
  },
  {
    key: "receipt-currency",
    title: "Show amounts in the customer's currency in receipt emails",
    description:
      "Receipts format every amount as EUR, even for USD customers: the number is right, the symbol is not. Noticed while reading the templates for the dunning work.",
    project: "billing-service",
    status: "backlog",
    priority: "low",
    createdBy: AGENTS.claudeCode,
    daysAgo: 2,
  },

  /* ---------------------------- mobile-app -------------------------- */
  {
    key: "offline-inbox",
    title: "Offline mode for the inbox",
    description:
      "The app is useless on a train. At minimum the inbox should load from cache and queue answers until the connection is back. The subtasks cover the cache and the write queue.",
    project: "mobile-app",
    status: "needs_refinement",
    priority: "high",
    createdBy: HUMANS.lena,
    daysAgo: 25,
    statusNote:
      "The cache and the write queue are split out and moving. Still undecided: may a user answer a decision while offline? The answer could reach the server after the agent has withdrawn the question, and nothing says what the user should see then.",
  },
  {
    key: "offline-cache",
    title: "Cache the inbox in on-device SQLite",
    description:
      "Persist the last inbox response and every task opened from it, keyed by id and version, so the inbox renders instantly and offline.",
    project: "mobile-app",
    status: "in_progress",
    priority: "high",
    createdBy: AGENTS.claudeCode,
    daysAgo: 24,
    parent: "offline-inbox",
    worker: AGENTS.nightly,
    acceptanceCriteria:
      "- The inbox renders from cache with no network\n- Cached rows older than the server's version are replaced on refetch\n- The cache is cleared when the workspace is signed out",
    comments: [
      {
        author: AGENTS.nightly,
        kind: "progress",
        body: "Went with expo-sqlite rather than MMKV: the inbox needs a query by status, which a key-value store would push into JS.",
      },
    ],
  },
  {
    key: "offline-write-queue",
    title: "Queue offline writes and replay them on reconnect",
    description:
      "Comments and decision answers made offline go into a queue and are replayed in order once the device is back online.",
    project: "mobile-app",
    status: "todo",
    priority: "high",
    createdBy: AGENTS.claudeCode,
    daysAgo: 23,
    parent: "offline-inbox",
    dependsOn: ["offline-cache"],
    acceptanceCriteria:
      "- The queue survives an app restart\n- Replays in order and stops at the first failure\n- Each write carries expectedVersion from the cached row",
  },
  {
    key: "offline-conflict-sheet",
    title: "Conflict sheet when a replayed write hits VERSION_CONFLICT",
    description:
      "When a queued write fails with VERSION_CONFLICT the user needs to see what changed and choose to retry or discard.",
    project: "mobile-app",
    status: "backlog",
    priority: "medium",
    createdBy: AGENTS.claudeCode,
    daysAgo: 22,
    parent: "offline-inbox",
    dependsOn: ["offline-write-queue"],
  },
  {
    key: "push-on-decision",
    title: "Push notification when an agent asks for a decision",
    description:
      "Decisions wait hours because nobody has the web app open. Send a push when a task enters needs_user_decision, deep-linking to the question.",
    project: "mobile-app",
    status: "needs_qa",
    priority: "high",
    createdBy: HUMANS.lena,
    daysAgo: 31,
    acceptanceCriteria:
      "- Push within 60 s of decision.requested\n- Tapping it opens the decision sheet, not the inbox\n- No push for decisions withdrawn before delivery",
    statusNote:
      "A small worker polls GET /events for decision.requested and sends through Expo push; tapping opens the decision sheet. To verify: request a decision from any agent with the TestFlight build installed — a push should land within a minute.",
    comments: [
      {
        author: HUMANS.lena,
        kind: "note",
        body: "Got the push on my phone in about 20 s. I'll test the withdrawn case tomorrow before marking it done.",
      },
    ],
  },
  {
    key: "ios17-keychain-crash",
    title: "Crash on launch on iOS 17.0 when the keychain is empty",
    description:
      "Sentry: 212 crashes in 6 hours, all iOS 17.0.x, all on first launch after install. The token read throws when the keychain item doesn't exist instead of returning null.",
    project: "mobile-app",
    status: "done",
    priority: "urgent",
    createdBy: AGENTS.ci,
    daysAgo: 57,
    worker: AGENTS.ci,
    reviewer: HUMANS.lena,
    acceptanceCriteria:
      "- First launch on a clean iOS 17.0 simulator works\n- A missing keychain item is treated as signed out",
    qaSummary:
      "Wrapped the keychain read so errSecItemNotFound maps to null. Verified on a clean iOS 17.0 simulator and a 17.5 device.",
    statusNote: "Hotfix 2.3.1 is live; the crash rate is back to baseline.",
    labels: ["bug"],
  },
  {
    key: "android-back-gesture",
    title: "Android back gesture exits the app from task detail",
    description:
      "Opening a task from a push notification and swiping back closes the app instead of going to the inbox — there's nothing under the detail screen in the stack.",
    project: "mobile-app",
    status: "done",
    priority: "medium",
    createdBy: HUMANS.marco,
    daysAgo: 44,
    reviewer: HUMANS.marco,
    acceptanceCriteria:
      "- Back from a deep-linked detail screen lands on the inbox\n- Back from the inbox exits as before",
    qaSummary: "Deep links from notifications now reset the stack to inbox → detail.",
    qaFeedback:
      "Works from a push, but a deep link opened from the browser still exits the app — that path goes through a different handler. Both entry points are in the criteria.",
    qaResubmit:
      "Moved the stack reset into the shared linking config, so browser links and pushes take the same path. Tested both on a Pixel 7 and the emulator.",
    labels: ["bug"],
  },
  {
    key: "voiceover-status-badges",
    title: "VoiceOver reads status badges as 'button'",
    description:
      "Status badges are Pressables (they open the status picker), so VoiceOver announces 'In progress, button' with no hint of what it does.",
    project: "mobile-app",
    status: "needs_qa",
    priority: "medium",
    createdBy: HUMANS.lena,
    daysAgo: 15,
    acceptanceCriteria:
      "- The badge announces its status and 'double tap to change status'\n- Read-only badges are not buttons\n- Checked with VoiceOver and TalkBack",
    statusNote:
      "Interactive badges now have a label and a hint; read-only badges are plain text. Checked with VoiceOver on iOS 18 and TalkBack on Android 15. To verify: turn on VoiceOver and swipe through the inbox.",
    labels: ["bug"],
  },
  {
    key: "deep-link-task-ref",
    title: "Deep links to TASK-000123 open the inbox instead of the task",
    description:
      "The link handler only knows numeric ids. Links pasted from Slack use the TASK-000123 reference form and fall through to the inbox.",
    project: "mobile-app",
    status: "todo",
    priority: "medium",
    createdBy: HUMANS.marco,
    daysAgo: 9,
    acceptanceCriteria:
      "- Both /tasks/123 and /tasks/TASK-000123 open the task\n- Unknown references show a not-found screen, not the inbox\n- Uses parseReference from contracts",
    labels: ["bug"],
  },
  {
    key: "app-store-screenshots",
    title: "Refresh App Store screenshots for the task manager rebrand",
    description:
      "The listing still shows the helpdesk ticket screens. Needs new screenshots for the 6.7-inch and 6.1-inch iPhones and the iPad.",
    project: "mobile-app",
    status: "backlog",
    priority: "medium",
    createdBy: HUMANS.lena,
    daysAgo: 13,
    assignee: HUMANS.lena,
  },
  {
    key: "react-native-081",
    title: "Upgrade React Native to 0.81",
    description:
      "0.81 turns the new architecture on by default and fixes the Android keyboard inset bug we currently patch by hand.",
    project: "mobile-app",
    status: "blocked",
    priority: "medium",
    createdBy: AGENTS.nightly,
    daysAgo: 16,
    worker: AGENTS.nightly,
    dependsOn: ["expo-sdk-54"],
    acceptanceCriteria:
      "- The app builds for iOS and Android\n- The keyboard inset patch is removed\n- The smoke test passes on both platforms",
    statusNote:
      "0.81 requires Expo SDK 54, which is its own task and hasn't started. Bumping React Native alone produces a native build that Expo's modules can't link against.",
  },
  {
    key: "expo-sdk-54",
    title: "Upgrade Expo SDK to 54",
    description:
      "Required for React Native 0.81. Mostly mechanical; expo-notifications changed how channels are created on Android.",
    project: "mobile-app",
    status: "todo",
    priority: "medium",
    createdBy: AGENTS.nightly,
    daysAgo: 17,
    acceptanceCriteria:
      "- `npx expo-doctor` is clean\n- Push notifications still arrive on Android 15\n- EAS build succeeds for both platforms",
  },
  {
    key: "biometric-unlock",
    title: "Unlock with Face ID or fingerprint",
    description:
      "The app keeps an API token on the device. Ask for a biometric check before the inbox opens.",
    project: "mobile-app",
    status: "needs_user_decision",
    priority: "low",
    createdBy: HUMANS.lena,
    daysAgo: 20,
    acceptanceCriteria:
      "- Uses the platform biometric prompt, no custom UI\n- Falls back to the device passcode",
    decision: {
      question: "Should biometric unlock be required, or opt-in?",
      options: [
        {
          label: "Opt-in from settings",
          description: "Nobody is surprised; most people will never turn it on.",
        },
        {
          label: "On by default",
          description: "Users can switch it off. Protects the token for everyone who doesn't.",
        },
        {
          label: "Required when a token is stored",
          description: "No choice for users; the token is what needs protecting.",
        },
      ],
      recommendedOption: "On by default",
      context:
        "Both platforms fall back to the passcode, so nobody gets locked out. The stored token grants full write access to the task API.",
    },
  },
  {
    key: "haptics",
    title: "Haptic feedback on claim and complete",
    description:
      "A light tap when a task is claimed and a success pattern when it moves to done. Small, but the app feels dead without it.",
    project: "mobile-app",
    status: "backlog",
    priority: "low",
    createdBy: HUMANS.marco,
    daysAgo: 35,
  },
  {
    key: "tablet-two-pane",
    title: "Two-pane layout on tablets",
    description:
      "On an iPad the inbox stretches to full width. List on the left and detail on the right would use the space.",
    project: "mobile-app",
    status: "needs_refinement",
    priority: "low",
    createdBy: HUMANS.marco,
    daysAgo: 30,
    statusNote:
      "No designs yet. Which screens get two panes — only the inbox, or the board too? And what should happen in split-screen multitasking, when the app is phone-width?",
  },
  {
    key: "avatar-image-cache",
    title: "Avatar images re-download on every scroll",
    description:
      "Scrolling the inbox fires a request per avatar per render. Noticed in the network inspector while profiling the list.",
    project: "mobile-app",
    status: "done",
    priority: "medium",
    createdBy: AGENTS.claudeCode,
    daysAgo: 39,
    reviewer: HUMANS.lena,
    acceptanceCriteria:
      "- Each avatar URL is fetched once per session\n- List scroll stays at 60 fps on a mid-range Android device",
    qaSummary:
      "Switched to expo-image with memory-disk caching. Requests while scrolling 200 rows went from 1,400 to 18.",
    labels: ["perf"],
  },
  {
    key: "sentry-sourcemaps",
    title: "Upload source maps to Sentry from the release workflow",
    description:
      "Crash reports show minified stack frames, which made the iOS 17 keychain crash take an hour longer to find than it should have.",
    project: "mobile-app",
    status: "done",
    priority: "high",
    createdBy: AGENTS.ci,
    daysAgo: 49,
    worker: AGENTS.ci,
    reviewer: HUMANS.lena,
    acceptanceCriteria:
      "- The release workflow uploads maps for the iOS and Android bundles\n- A test crash in a release build shows original file names",
    qaSummary:
      "The release workflow now uploads source maps after the EAS build. A test crash on a release build shows src/ paths in Sentry.",
  },

  /* --------------------------- no project --------------------------- */
  {
    key: "overnight-digest",
    title: "Morning digest of what agents finished overnight",
    description:
      "One message at 9:00 listing what moved to needs_qa or done overnight, grouped by project. Not sure yet where it should be delivered.",
    project: null,
    status: "backlog",
    priority: "low",
    createdBy: HUMANS.krisz,
    daysAgo: 5,
  },
  {
    key: "slack-decision-bridge",
    title: "Post decision requests to Slack",
    description:
      "Most of us live in Slack. Posting new decision requests to a channel, with a button per option, would cut how long decisions wait.",
    project: null,
    status: "backlog",
    priority: "medium",
    createdBy: HUMANS.dana,
    daysAgo: 1,
  },
];

/* ------------------------------------------------------------------ *
 * Working notes
 * ------------------------------------------------------------------ */

/**
 * `progress` comments an agent leaves while it holds a task. Drawn by the PRNG
 * for every stretch of `in_progress`, so threads read like a working log without
 * 62 bespoke ones. Worded to fit any task on purpose.
 */
export const PROGRESS_NOTES: readonly string[] = [
  "Picked this up. Reading the existing code and tests before changing anything.",
  "Reproduced it with a failing test; the fix is next.",
  "Plan: failing test first, then the change, then the docs page. On step one.",
  "Implementation done; running the full suite before handing it off.",
  "Happy path works. Working through the edge cases in the acceptance criteria now.",
  "Rebased on main after the last merge; two conflicts in the tests, both resolved.",
  "Lint and typecheck are clean. Writing up what changed for the reviewer.",
  "Found an existing helper that does most of this, so the diff is smaller than expected.",
  "CI was red on an unrelated flaky test; re-ran it and it passed. Continuing.",
  "Checkpoint: the core change is committed on the branch; the remaining work is tests and docs.",
  "Took a wrong turn with a query per row — reverted to a single join. Back on track.",
  "Added the regression test from the description; it fails on main and passes on the branch.",
];

export interface Weighted<T> {
  value: T;
  weight: number;
}

/** Progress notes per stretch of `in_progress`. */
export const PROGRESS_COUNT_WEIGHTS: readonly Weighted<number>[] = [
  { value: 1, weight: 3 },
  { value: 2, weight: 3 },
  { value: 3, weight: 1 },
];

/* ------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------ */

/**
 * Drives every timestamp and every drawn working note. Statuses are authored,
 * so this value is *not* tuned for a distribution the way the helpdesk seed's
 * was — any value produces the same task set with different timings.
 */
export const PRNG_SEED = 24_073;

export const SEED_TASK_COUNT = 62;

export const SEED_WINDOW_DAYS = 60;
