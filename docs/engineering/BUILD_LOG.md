# Build log — deferred work & performance

Companion to [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md). The plan says what to build and in
what order; this file records what each stage actually left behind.

Three things are tracked, and nothing else:

1. **Stage ledger** — one row per stage: gate result, review verdict, commit.
2. **Deferred work** — anything a stage did not finish, with the reason and where it lands.
3. **Performance** — observations and improvement candidates, so they accumulate in one place
   instead of being rediscovered per stage.

An item leaves this file only when it is done (or explicitly rejected with a reason).

## Stage ledger

| Stage | Gate | Review | Commit |
| ----- | ---- | ------ | ------ |
| _(pending)_ | | | |

## Deferred work

| # | Item | Raised in | Reason deferred | Lands in |
| - | ---- | --------- | --------------- | -------- |
| _(none yet)_ | | | | |

## Performance ledger

Candidates are recorded when observed and only actioned when a stage's gate or a measurement
justifies it — the project is a graded take-home on SQLite, not a system under load.

| # | Observation | Impact | Action |
| - | ----------- | ------ | ------ |
| _(none yet)_ | | | |
