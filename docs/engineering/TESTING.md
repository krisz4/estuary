# Testing

Bonus item 4 of the brief: "write realistic tests". Realistic means tests that would have caught a real bug — not a suite that asserts a component renders.

## Layers

| Layer | Tool | Location | Runs against |
| ----- | ---- | -------- | ------------ |
| Contract unit | vitest | `packages/contracts/src/*.test.ts` | Pure schemas |
| Service unit | vitest | `apps/api/src/services/*.test.ts` | Temp SQLite file |
| API integration | vitest + supertest | `apps/api/src/routes/*.test.ts` | Real Express app + temp SQLite |
| Component | vitest + RTL + MSW | `apps/web/src/**/*.test.tsx` | Mocked HTTP |
| E2E | Playwright | `e2e/*.spec.ts` | Both apps, real DB |

Weight sits on **API integration** — five endpoints where filtering, sorting, paging, validation, and cascade all live. That is where the bugs are.

## Commands

```bash
pnpm test              # all workspaces
pnpm test:api
pnpm test:web
pnpm test:e2e          # Playwright boots both apps via webServer
pnpm test:coverage
```

## Database isolation

`DATABASE_URL` is set in **`apps/api/vitest.setup.ts`, registered as a `setupFiles` entry** — not in a `beforeAll`. `lib/prisma.ts` instantiates the client at *import* time, and test modules are imported before any hook runs, so a `beforeAll` assignment lands too late and the suite quietly runs against the developer's real database.

Each vitest worker gets its own file at `${os.tmpdir()}/helpdesk-test-${process.env.VITEST_WORKER_ID}.db`, and every one of them is removed at teardown. Per-worker rather than per-file, because vitest runs files in parallel across workers and a shared file would deadlock on SQLite's single writer. `beforeEach` truncates.

The schema comes from `prisma migrate deploy`, run **once** in `globalSetup` against a template file (`helpdesk-test-template.db`) that each worker then copies. `globalSetup` has no way to know how many workers vitest will spawn, and the CLI costs ~0.6 s per invocation against a ~1 ms file copy — so the migration runs once and fans out by copying.

Non-negotiable: **tests never touch `apps/api/prisma/data/helpdesk.db`** and never use the seed. A developer losing local data to a test run is unacceptable, and a suite coupled to seed output breaks whenever the seed changes.

Fixtures are explicit builders — `makeTicket({ status: "resolved", priority: "urgent" })` — so each test declares exactly the data its assertion depends on.

## What must be covered

### Tickets ([../features/Tickets.md](../features/Tickets.md))

- Create: happy path returns 201, `Location`, an integer `id`, its `reference`, and defaults (`open` / `medium`).
- Create: each validation failure → 422 with the field named in `details`.
- Create: rejects client-supplied `id` / `createdAt` (`.strict()`).
- Create: `assignee: ""` and `category: ""` are stored as `null`, not as empty strings.
- Get: 200 with comments ordered oldest-first; unknown id → 404 `TICKET_NOT_FOUND`; **non-numeric id (`/tickets/abc`) → 404, not 422 or 500**.
- Patch: partial update leaves untouched fields alone; empty body → 422 `AT_LEAST_ONE_FIELD`; unknown id → 404.
- Patch: clearing `assignee` to `""` makes the ticket appear under `assigneeIsNull=true`. (The regression test for the empty-string-vs-null trap.)
- Delete: 204, then GET → 404, **and the ticket's comments are gone** (cascade).
- Delete twice: second is 404, not 500.
- Facets: returns only distinct non-null values actually present, sorted.

### List query ([../features/Ticket_Query_Filter_Sort_Page.md](../features/Ticket_Query_Filter_Sort_Page.md))

This section carries the most weight.

- Defaults: page 1, size 20, `createdAt:desc`.
- Paging: `meta.total` / `totalPages` / `hasNextPage` correct; page beyond the end → empty `data`, not 404; **no row appears on two pages and none is skipped** (page 1 + page 2 ids are disjoint and cover the set).
- `pageSize=0`, `pageSize=101`, `page=0` → 422. Empty values (`?page=&pageSize=`) fall back to defaults instead.
- Filters: single, repeated (OR within a param), and combined (AND across params).
- `assigneeIsNull=true` returns only unassigned; sending it together with `assignee` → 422.
- A ticket assigned to someone literally named "None" is returned by `assignee=None` and **not** by `assigneeIsNull=true` — the test that would have caught the old sentinel design.
- `q` matches title, matches description, and matches `HD-000042`, `hd-42`, `#42`, and bare `42`.
- **`q` combined with a status filter narrows, never widens** — assert that a ticket matching `q` but not the status filter is absent. Catches the hoisted-`OR` bug.
- Date range: `createdTo` set to a ticket's own creation date **includes** that ticket (the off-by-one-day bound).
- **Sorting by priority puts `urgent` first, not alphabetical** — the regression test for the rank columns.
- Sorting by status follows lifecycle order.
- Sorting by a non-unique key (e.g. `status`) across two pages: ids are disjoint and cover the set — proves the `id` tiebreaker is applied.
- Unknown sort field / unknown query param → 422.

### Status lifecycle ([../features/Ticket_Status_Lifecycle.md](../features/Ticket_Status_Lifecycle.md))

- Each legal transition succeeds.
- `closed → resolved` → 409 `INVALID_STATUS_TRANSITION` with `details.allowed`.
- **Same-status update does not change `updatedAt`** — the assertion that proves the no-op short-circuits before the write rather than writing identical values.
- `resolved` sets `resolvedAt`; `closed` sets `closedAt` and backfills `resolvedAt`.
- `resolved → in_progress` **clears `resolvedAt`**, and `closed → open` clears both. Reopening from either state, not just from `closed`.
- **`statusRank` / `priorityRank` stay consistent after every write path** — assert by sorting, not by reading the column.

### Comments ([../features/Comments.md](../features/Comments.md))

- Add → 201, appears in the ticket's thread in order.
- **Add to a missing ticket → 404 `TICKET_NOT_FOUND`, not 500.** Without the explicit existence check this path raises Prisma `P2003` and falls through to `INTERNAL_ERROR`.
- Adding a comment does **not** change the ticket's `updatedAt`.
- Several comments created in the same millisecond come back in insertion order (the `id` tiebreaker).
- Delete a comment belonging to a different ticket → 404, not 200 and not 403.
- Validation: empty body, over-length body.

### Errors ([API_ERROR_CONTRACT.md](./API_ERROR_CONTRACT.md))

- Every error response has `code`, `message`, `requestId`.
- A forced internal error returns a generic message with **no stack trace**.
- Unknown route → 404 `NOT_FOUND`.
- **Malformed JSON body → 400 `MALFORMED_JSON`** (not 500).
- **Body over `BODY_LIMIT` → 413 `PAYLOAD_TOO_LARGE`** (not 500).
- Every code in the contract table has a test that produces it — that is the check that keeps unreachable codes out of the table.

### Web components

- `TicketFilterBar`: changing a filter updates the URL and resets `page` to 1.
- `useTicketListParams`: garbage params fall back to defaults without throwing.
- `TicketForm`: shows field errors, maps a server `VALIDATION_ERROR` onto fields, and **keeps values after a failed submit**.
- List page: renders loading skeleton → rows; renders the correct empty variant for "no tickets" vs "no matches"; error panel retry refetches.
- `ConfirmDialog`: cancel does not fire the mutation.

MSW intercepts at the network layer so the real query hooks and fetch client are exercised — mocking the hooks would test the mock.

### E2E (happy paths only)

**Data strategy.** Playwright `globalSetup` points the API at its own database (`e2e/helpdesk-e2e.db`), runs `migrate deploy`, and seeds it with `ALLOW_SEED=true` — the suite needs enough rows for filtering and paging to be meaningful, which is the one place seed data is legitimate. It is a **third** database: not the dev file, not the vitest temp files.

Because the suite shares one database across specs, **every test that mutates creates its own ticket first and acts on that one.** No spec may delete or edit a seeded ticket, or the run becomes order-dependent and fails only in CI. `globalSetup` re-seeds from scratch on every run, so a crashed run never poisons the next one.

1. Create a ticket → land on its detail page → it appears at the top of the list.
2. Filter by status, sort by priority, page forward — URL reflects each step and survives reload.
3. Open a ticket, add a comment, change status, verify both persist after reload.
4. Create a ticket, then delete it → confirm → gone from the list.
5. Load the list at 375px width and confirm the card layout renders (the brief grades mobile).

## Conventions

- Test names state the behavior: `"returns 409 when closing a ticket is followed by setting it back to resolved"`, not `"test status"`.
- One assertion subject per test; multiple `expect`s about that subject are fine.
- No `waitFor(() => {})` polling where a proper `findBy*` query works.
- No snapshot tests of whole components — they fail on every copy change and get regenerated without reading.
- CI runs `typecheck` → `lint` → `test` → `test:e2e`.

## Related

- [../features/Seed_Data.md](../features/Seed_Data.md) — deliberately unused by tests
- [ARCHITECTURE.md](./ARCHITECTURE.md) — the seams that make this testable
