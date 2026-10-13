---
type: Page
title: Connect an agent
description: Check instance readiness, configure an MCP client, and complete the first handoff.
resource: apps/web/src/pages/connect/
tags: [agents, onboarding, mcp]
status: canonical
---

## Route and dependencies

`/connect`, reached through the header's **Connect agent** link. `ConnectPage` uses `GET /api/v1/system/ready` and polls `GET /api/v1/system/agents` every five seconds with the browser's usual token and actor headers.

## Flow

1. Check the browser's configured API and database. The editable API address is the address the agent will use; changing it does not change the browser's instance.
2. Select Codex, Claude Code, Cursor, or another MCP client. Copy a TOML server entry for Codex or a JSON entry for the other clients. Configuration uses `npx -y estuary-mcp` and `TASKS_CLIENT`; required tokens are represented by a placeholder, never copied from browser storage. For unreleased changes, run the locally built MCP server as described in [Agent integration](../features/Agent_Integration.md).
3. Ask the agent to run `task_ping`. Sessions contacting this instance after the page opened appear with actor and last activity. This checks connectivity, not ownership authentication. The registry is in memory, expires after five minutes, and resets at API restart.
4. Create a small task, have the agent claim and submit it with verification evidence, then review it in the inbox.

## States, responsive layout, and accessibility

Readiness and connection errors have retry controls. Waiting for an agent uses a live announcement. Form controls have labels; configuration can be focused and selected if clipboard access fails. Steps stack at narrow widths; long configuration scrolls within its own panel.

## Related

[Agent integration](../features/Agent_Integration.md) · [Task workflow API](../features/Task_Workflow_API.md) · [Inbox](./Inbox.md)
