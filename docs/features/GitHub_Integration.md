---
type: Feature
title: GitHub integration
description: Optional link between tasks and GitHub — live PR/issue status, an inbound webhook that links and comments on pull requests, and issue import.
resource: apps/api/src/services/github.service.ts
tags: [github, integration, webhook, pull-requests, optional]
status: canonical
---
# GitHub integration

Optional. Off unless the API is given `GITHUB_TOKEN` and/or `GITHUB_WEBHOOK_SECRET`. With neither set, every route here answers `INTEGRATION_NOT_CONFIGURED` (404) and the rest of the app is unchanged — no accounts, no OAuth app, just server-level config.

## Overview

| Concern | Location |
| ------- | -------- |
| Shapes + URL parsing | `packages/contracts/src/github.ts` |
| Reference matching (`TASK-42` in a PR title/body/branch) | `packages/contracts/src/reference.ts` (`findReferences`) |
| Business logic | `apps/api/src/services/github.service.ts` |
| HTTP layer | `apps/api/src/routes/github.route.ts` (three routers — see below) |
| GitHub REST client | `apps/api/src/lib/github-client.ts` |
| Env vars | `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_API_URL` — [../engineering/ENVIRONMENT_VARIABLES.md](../engineering/ENVIRONMENT_VARIABLES.md) |
| MCP tool | `task_import_github_issue`, plus GitHub status lines on `task_get` — [Agent_Integration.md](./Agent_Integration.md) |

## What it does

Three independent pieces, each gated by its own half of the config:

1. **Live link status — `GET /tasks/:taskId/github`.** Every link on a task that parses as a GitHub PR or issue URL (`parseGithubUrl`) is resolved live: title, state (`open` / `draft` / `merged` / `closed`), and — for a PR — the combined check status of its head commit. Cached 60s per URL, in-process. One link's failure (deleted, private without a token, rate-limited) carries `error` instead of `state`; it never fails the rest of the response. Needs `isIntegrationEnabled()` (either env var).
2. **The webhook — `POST /integrations/github/webhook`.** GitHub calls this itself on `pull_request` events. A relevant action (`opened`, `reopened`, `ready_for_review`, `closed`, `edited`) whose title, body, or head branch names a task (`TASK-42`, `feat/TASK-42`, …) gets the PR appended to that task's `links` (deduped by URL, capped at `TASK_LINKS_MAX`), a `github.pull_request` event, and — for `opened` / `reopened` / `closed` — a `note` comment ("PR owner/repo#12 opened: …"). **Never changes status.** Attributed to `system:github`. Needs `GITHUB_WEBHOOK_SECRET`.
3. **Issue import — `POST /integrations/github/import`.** Turns a GitHub issue into a task through the normal create path (`createTask`), so idempotency, validation, and the `Location`/status-code rules match a manual `POST /tasks`. `project` defaults to the repo name as a slug; status is `backlog` or `needs_refinement` (never `todo` — an imported issue carries no acceptance criteria). Needs `GITHUB_TOKEN` to reach private repos; without it, calls are anonymous (public repos, 60 req/hour).

`GET /integrations/github` reports `{ enabled, tokenConfigured, webhookConfigured, webhookPath }` and is reachable even when the integration is fully off, so a client can tell why.

## Rules

- **Reference matching is `TASK-\d+` only, not `#\d+`.** `#42` on GitHub means a PR or issue number in that repo; reading it as a task id would attach PRs to unrelated tasks. See `findReferences` in `packages/contracts/src/reference.ts`.
- **A PR can reference more than one task.** Every `TASK-n` found in the title, body, or head branch gets linked, independently.
- **Redelivery-safe.** GitHub redelivers webhook events; a delivery already recorded for a task (matched by `X-GitHub-Delivery` stored in the event payload) is skipped — no duplicate link, event, or comment. Checked per task, since the same delivery can name several tasks.
- **The webhook never changes task status.** Only a human or an agent moves a task through the workflow; the integration's job is visibility, not automation.
- **One bad GitHub link never fails a response.** `GET /tasks/:taskId/github` resolves every link independently and reports `error` on the ones that failed.
- **Attribution is `system:github`.** Same rule as an auto-unblock's `system:taskmanager`: `actorKindOf()` reads the `system:` prefix and the claim guard never refuses a system actor, so the webhook can comment and update links on a task someone else has claimed.
- **Import is idempotent per issue**, the same rule as `idempotencyKey` on `POST /tasks`: the key is `github:<owner>/<repo>#<n>` (`githubImportKey`), and importing the same **open** issue twice returns the existing task (200). Once that task is `done` or `deferred`, the key is retired and a re-import creates a fresh task (201) — see [Task_Workflow_API.md § Idempotent create](./Task_Workflow_API.md#idempotent-create).
- **The GitHub token is never logged or echoed** on any response, including `GET /integrations/github` (`tokenConfigured` is a boolean, not the value).

## API

| Method | Path | Auth | Success | Notes |
| ------ | ---- | ---- | ------- | ----- |
| GET | `/integrations/github` | normal (`X-Actor` / bearer, if set) | 200 `GithubIntegrationStatus` | Reachable even when disabled |
| GET | `/tasks/:taskId/github` | normal | 200 `TaskGithubStatus` (`{ data: GithubLinkStatus[] }`) | Live, 60s cache per URL |
| POST | `/integrations/github/import` | normal | 201 `Task` + `Location`; 200 on replay | Body: `GithubImportInput` — `issue` (URL or `owner/repo#123`), `project?`, `status?` (`backlog`\|`needs_refinement`), `priority?`, `labels?` |
| POST | `/integrations/github/webhook` | HMAC signature only — **not** the bearer token or `X-Actor` | 200 `{ linkedTasks: number[] }` (or `{ ok: true }` for `ping`, `202 { ignored: true }` for an irrelevant event/action) | Mounted before the JSON body parser and the `apiToken`/`actor` middleware — see `app.ts` |

### Error codes

| Code | Status | When |
| ---- | ------ | ---- |
| `INTEGRATION_NOT_CONFIGURED` | 404 | A GitHub route while neither env var is set (the webhook specifically needs `GITHUB_WEBHOOK_SECRET`) |
| `INVALID_WEBHOOK_SIGNATURE` | 401 | Missing or wrong `X-Hub-Signature-256` |
| `GITHUB_NOT_FOUND` | 404 | Import: no such issue, or it is private and the token cannot see it |
| `GITHUB_UNAVAILABLE` | 502 | Import: GitHub did not answer, errored, or rate-limited the request |
| `VALIDATION_ERROR` | 422 | Import: `issue` is a pull request URL, not an issue |

Full table: [../engineering/API_ERROR_CONTRACT.md](../engineering/API_ERROR_CONTRACT.md).

## Connect it

1. **Create a token** (fine-grained personal access token, or a GitHub App installation token) with **read-only** access to: Pull requests, Issues, Commit statuses (for check state) — on the repositories the integration should watch. No write scopes are needed; the integration never pushes, comments through the GitHub API, or changes PR/issue state itself. Set it as `GITHUB_TOKEN`.
2. **Generate a webhook secret** (e.g. `openssl rand -hex 32`) and set it as `GITHUB_WEBHOOK_SECRET` (≥ 16 characters).
3. **Add a repository webhook** (repo → Settings → Webhooks → Add webhook):
   - Payload URL: `<API origin>/api/v1/integrations/github/webhook`
   - Content type: `application/json`
   - Secret: the value of `GITHUB_WEBHOOK_SECRET`
   - Events: **Pull requests** only
4. **A localhost API is not reachable from GitHub's servers.** Tunnel it first (e.g. `smee.io`, `cloudflared tunnel`, `ngrok`) and point the webhook at the tunnel's public URL; GitHub redelivers on failure, so a dropped delivery during setup is not lost.
5. Restart the API so `env.ts` picks up the new variables. `GET /api/v1/integrations/github` confirms what is on.

### When disabled

- `enabled: false`, `tokenConfigured: false`, `webhookConfigured: false` on `GET /integrations/github`.
- `GET /tasks/:taskId/github`, `POST /integrations/github/import`, and the webhook all answer `INTEGRATION_NOT_CONFIGURED` (404).
- Nothing else in the app changes: a task can still carry a GitHub URL as an ordinary link (`taskLinkSchema` does not require a GitHub host), it is simply never resolved or auto-linked.
- The MCP server degrades quietly: `task_get` asks for GitHub status only when a task has a link that parses as one, and remembers `INTEGRATION_NOT_CONFIGURED` for the life of the server so a disabled integration costs one request, once (`apps/mcp/src/tools.ts`).

## Related

- [Tasks.md](./Tasks.md) — `links` on the task resource
- [Task_Workflow_API.md](./Task_Workflow_API.md) — events, idempotent create
- [Agent_Integration.md](./Agent_Integration.md) — `task_import_github_issue`, GitHub status lines
- [../engineering/ENVIRONMENT_VARIABLES.md](../engineering/ENVIRONMENT_VARIABLES.md)
- [../engineering/API_ERROR_CONTRACT.md](../engineering/API_ERROR_CONTRACT.md)
