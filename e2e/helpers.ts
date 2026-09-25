import { type APIRequestContext, expect, type Locator, type Page } from "@playwright/test";
import {
  type Comment,
  type CreateCommentInput,
  type CreateTaskInputRaw,
  type DecisionRequest,
  type EventsResponse,
  type NextTaskInput,
  type NextTaskResponse,
  type Task,
  type TaskStats,
  type TransitionInput,
  type UpdateTaskInput,
} from "@helpdesk/contracts";

import { API_BASE_URL } from "./env";

/**
 * Shared spec helpers.
 *
 * The rule these exist to serve is in `docs/engineering/TESTING.md`: **every
 * spec that mutates creates its own task and acts on that one.** No spec edits
 * or deletes a seeded row, because the suite shares one database and the first
 * spec to delete `TASK-000007` makes every later run's failure depend on which
 * order the files happened to run in.
 *
 * Fixtures are built over the **API**, not through the UI. `create-task.spec.ts`
 * is the one that proves the form works; the others are about transitions,
 * the inbox, the board, and deletion, and driving the form to get there would
 * make them fail for a reason they are not testing.
 *
 * The API helpers also play the **agent**. The product is a task manager that
 * humans and AI agents share, and several specs are about the hand-off between
 * the two — an agent asks a question, a human answers it in the browser. The
 * agent's half is exactly what an agent does: HTTP calls carrying
 * `X-Actor: agent:<name>`. There is no MCP server in the loop because the MCP
 * server is itself a thin client of these same endpoints.
 *
 * The imports from `@helpdesk/contracts` are **types only**, on purpose: a value
 * import would make `pnpm test:e2e` depend on the package having been built,
 * and the E2E script deliberately does not run through turbo's build graph.
 */

/** The actor every agent-side call in the suite uses. */
export const AGENT = "agent:e2e-bot";

/** What a request without `X-Actor` is recorded as — the browser before "You" is set. */
export const ANONYMOUS = "human:anonymous";

/**
 * Priority badge labels in rank order — the *rendered* spelling, not the wire
 * value, because this is read back off the page.
 *
 * Written as a literal rather than derived from `TASK_PRIORITIES` and the web
 * app's label map: the filter spec asserts that `sort=priority:desc` puts urgent
 * first, and deriving the expected order from the same tables the page renders
 * from would let both sides degrade together.
 */
export const PRIORITY_LABEL_RANK: Record<string, number> = {
  Low: 0,
  Medium: 1,
  High: 2,
  Urgent: 3,
};

/** Every status label except the two closed ones — the "Open work" preset, as rendered. */
export const OPEN_STATUS_LABELS = [
  "Backlog",
  "Needs refinement",
  "To do",
  "In progress",
  "Blocked",
  "Needs decision",
  "Needs action",
  "Needs QA",
];

const suffix = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A title no other spec, run, or seeded row can collide with.
 *
 * Collisions matter more than they look: several specs find their own task by
 * searching for it, and `?q=` matches substrings of both title and description.
 */
export const uniqueTitle = (label: string): string => `E2E ${label} ${suffix()}`;

/**
 * A project slug of this test's own. It is what makes `POST /tasks/next`
 * deterministic: `next` hands out the best task *in the given projects*, and a
 * project nobody else uses contains exactly the task the spec just made — never
 * one of the seeded `todo` rows.
 */
export const uniqueProject = (label: string): string => `e2e-${label}-${suffix()}`;

/* ------------------------------------------------------------------ *
 * The API, as a human or an agent
 * ------------------------------------------------------------------ */

type CallOptions = {
  /** `X-Actor`. Omitted → the server records `human:anonymous`. */
  actor?: string;
  /** The status the call must answer with; asserted here so a failed fixture says so. */
  expectStatus?: number;
};

const headers = (actor: string | undefined): Record<string, string> =>
  actor === undefined ? {} : { "X-Actor": actor };

/**
 * One API call with its status asserted.
 *
 * The assertion is here rather than in the caller so a fixture that fails to be
 * built reports *that*, with the server's error body, instead of surfacing three
 * lines later as a page rendering its not-found state.
 */
const call = async <T>(
  request: APIRequestContext,
  method: "get" | "post" | "patch" | "delete",
  path: string,
  { actor, expectStatus = 200, data }: CallOptions & { data?: unknown } = {},
): Promise<T> => {
  const response = await request[method](`${API_BASE_URL}${path}`, {
    headers: headers(actor),
    ...(data === undefined ? {} : { data }),
  });
  expect(response.status(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(
    expectStatus,
  );
  return (response.status() === 204 ? undefined : await response.json()) as T;
};

export const taskPayload = (overrides: Partial<CreateTaskInputRaw> = {}): CreateTaskInputRaw => ({
  title: uniqueTitle("fixture"),
  description: "Created by the end-to-end suite. Safe to delete.",
  priority: "medium",
  acceptanceCriteria: "The end-to-end spec that made this task passes.",
  ...overrides,
});

/** `POST /tasks`. Starts in `backlog` unless `status` says otherwise. */
export const createTask = (
  request: APIRequestContext,
  overrides: Partial<CreateTaskInputRaw> = {},
  options: CallOptions = {},
): Promise<Task> =>
  call<Task>(request, "post", "/tasks", {
    ...options,
    expectStatus: options.expectStatus ?? 201,
    data: taskPayload(overrides),
  });

export const getTask = (request: APIRequestContext, taskId: number): Promise<Task> =>
  call<Task>(request, "get", `/tasks/${taskId}`);

/** `GET /tasks/:id`'s status alone — used to assert a delete stuck. */
export const getTaskStatus = async (request: APIRequestContext, taskId: number): Promise<number> =>
  (await request.get(`${API_BASE_URL}/tasks/${taskId}`)).status();

export const updateTask = (
  request: APIRequestContext,
  taskId: number,
  patch: UpdateTaskInput,
  options: CallOptions = {},
): Promise<Task> => call<Task>(request, "patch", `/tasks/${taskId}`, { ...options, data: patch });

export const transitionTask = (
  request: APIRequestContext,
  taskId: number,
  input: TransitionInput,
  options: CallOptions = {},
): Promise<Task> =>
  call<Task>(request, "post", `/tasks/${taskId}/transition`, { ...options, data: input });

export const claimTask = (
  request: APIRequestContext,
  taskId: number,
  options: CallOptions = {},
): Promise<Task> => call<Task>(request, "post", `/tasks/${taskId}/claim`, { ...options, data: {} });

export const nextTask = (
  request: APIRequestContext,
  input: NextTaskInput,
  options: CallOptions = {},
): Promise<NextTaskResponse> =>
  call<NextTaskResponse>(request, "post", "/tasks/next", { ...options, data: input });

export const addComment = (
  request: APIRequestContext,
  taskId: number,
  input: CreateCommentInput,
  options: CallOptions = {},
): Promise<Comment> =>
  call<Comment>(request, "post", `/tasks/${taskId}/comments`, {
    ...options,
    expectStatus: 201,
    data: input,
  });

export const getStats = (request: APIRequestContext): Promise<TaskStats> =>
  call<TaskStats>(request, "get", "/tasks/stats");

export const getTaskEvents = (
  request: APIRequestContext,
  taskId: number,
): Promise<EventsResponse> => call<EventsResponse>(request, "get", `/events?taskId=${taskId}`);

/**
 * An agent's whole path to asking a human something, as an agent would walk it:
 * file a ready task, take it with `POST /tasks/next`, then stop and ask.
 *
 * The task lives in a project of its own, so `next` can only return it.
 */
export const agentAsksForDecision = async (
  request: APIRequestContext,
  decision: DecisionRequest,
  overrides: Partial<CreateTaskInputRaw> = {},
): Promise<Task> => {
  const project = uniqueProject("decision");
  const created = await createTask(
    request,
    { status: "todo", project, title: uniqueTitle("decision"), ...overrides },
    { actor: AGENT },
  );

  const { task: claimed } = await nextTask(request, { project: [project] }, { actor: AGENT });
  expect(claimed?.id, "POST /tasks/next handed out a different task").toBe(created.id);
  expect(claimed?.status).toBe("in_progress");
  expect(claimed?.claim?.actor).toBe(AGENT);

  return transitionTask(
    request,
    created.id,
    { to: "needs_user_decision", decision },
    { actor: AGENT },
  );
};

/** For building a `RegExp` around text a spec typed — reasons end in a full stop. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ------------------------------------------------------------------ *
 * Page helpers
 * ------------------------------------------------------------------ */

/**
 * The list page's rows, as one locator regardless of which layout is rendered.
 *
 * Above `md` the list is a `<table>`; below it, a `<ul>` of card links — two
 * different components, not one component with a media query, so a spec that
 * wants "the rows" has to say which. Everything except the mobile spec runs at
 * the desktop viewport and uses `tableRows`.
 */
export const tableRows = (page: Page): Locator => page.locator("table tbody tr");

/**
 * The trimmed text of one column across every row on the current page, in order.
 *
 * Read through `expect.poll` at the call sites rather than once, because the
 * list **keeps the previous page's rows on screen while the next one loads**
 * (`keepPreviousData`, dimmed and `aria-busy`, per the design guidelines). A
 * single read straight after a click is therefore a genuine race with the
 * refetch.
 */
export const columnTexts = async (page: Page, nth: number): Promise<string[]> =>
  (await tableRows(page).locator(`td:nth-child(${nth})`).allInnerTexts()).map((text) =>
    text.trim(),
  );

/** The `TASK-000042` reference cell of every row on the current page, in order. */
export const rowReferences = (page: Page): Promise<string[]> => columnTexts(page, 1);

/** The detail page's status picker — a Radix select, so a `combobox` by role. */
export const statusPicker = (page: Page): Locator =>
  page.getByRole("combobox", { name: "Status", exact: true });

/** Opens a Radix select and picks one option by its visible label. */
export const pickOption = async (page: Page, trigger: Locator, option: string): Promise<void> => {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
};

/**
 * The header's inbox link. Its accessible name carries the count in words —
 * "Inbox, 3 waiting on you" — while the visible pill is `aria-hidden`.
 */
export const inboxLink = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Inbox/ });

export const inboxLabel = (count: number): string =>
  count === 0 ? "Inbox" : `Inbox, ${count} waiting on you`;

/** One task's card in the inbox — an `<article>` named by the task's title. */
export const inboxItem = (page: Page, task: Pick<Task, "title">): Locator =>
  page.getByRole("article", { name: task.title });

/** The detail page's activity timeline. */
export const activity = (page: Page): Locator => page.getByRole("region", { name: "Activity" });
