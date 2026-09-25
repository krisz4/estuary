---
type: Feature
title: Actors
description: How humans and agents are told apart without accounts — the X-Actor header, the optional API token, and the one rule keyed on actor kind.
resource: apps/api/src/middleware/actor.ts
tags: [actors, agents, auth, attribution]
status: canonical
---
# Actors

## What an actor is

An **actor** is a self-declared label for whoever made a request: `agent:claude-code`, `agent:claude-code-ci`, `human:krisz`. It is recorded as `createdBy` on tasks, `author` on comments, `requestedBy` / `answeredBy` on decisions, `claimedBy` on claims, and `actor` on every event.

It is **attribution, not identity.** There are still no accounts and no logins — nothing verifies that a request claiming `human:krisz` came from Krisz. The value of the label is an honest timeline for honest callers: which agent did what, and which changes a person made.

| Form | Rule |
| ---- | ---- |
| `human:<name>` / `agent:<name>` | Lowercase, `<name>` = letters, digits, `. _ @ / -`, max 64. Validated by `actorSchema` in `packages/contracts/src/actor.ts`. |
| `system:taskmanager` | Reserved for writes the server makes itself (auto-unblock). Rejected when sent by a client. |
| *(no header)* | `human:anonymous` |

The web app sends `human:<slug of the name you set under "You">`. The MCP server sends `TASKS_ACTOR` (default `agent:claude-code`). A malformed header is a `VALIDATION_ERROR` with `details["X-Actor"]`, on reads as well as writes — silently falling back to anonymous would hide an agent's misconfiguration.

## Rules keyed on the actor kind

Only two, both guards against a *well-behaved* agent overreaching, not against a hostile caller (who can simply claim to be human):

1. **Agents stop at `needs_qa`.** An `agent:` actor moving a task to `done` gets `ACTOR_NOT_PERMITTED` (403) unless the server runs with `AGENTS_MAY_COMPLETE=true`.
2. **Agents respect claims; humans override them.** While anyone holds a live claim on a task, agents other than the holder cannot write it (`TASK_ALREADY_CLAIMED`). Humans can always write, and a human may `release` anyone's claim.

## The optional API token

For a self-hosted instance reachable beyond localhost, set `API_TOKEN` (≥ 16 characters). Every `/api/v1` request must then carry `Authorization: Bearer <API_TOKEN>`, or it gets `UNAUTHORIZED` (401). `/health` and `/docs` stay open.

It is one shared secret for every caller — a gate, not accounts. The web app stores it per browser (entered under "You"); the MCP server reads `TASKS_API_TOKEN`. On localhost, leave it unset.

## Why not real authentication

Accounts, roles, and permissions remain out of scope (see `CLAUDE.md`). The task manager's users are one person or a small team plus their agents on a machine or network they control; attribution plus an optional shared gate covers that without a user table, sessions, or password handling. If the tool ever serves people who should not trust each other, this page is the one to replace.

## Related

- [Task_Workflow_API.md](./Task_Workflow_API.md) — the header and token in the request reference
- [Agent_Integration.md](./Agent_Integration.md) — configuring the actor for Claude Code
- [../engineering/ENVIRONMENT_VARIABLES.md](../engineering/ENVIRONMENT_VARIABLES.md)
