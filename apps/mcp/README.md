# estuary-mcp

A stdio [MCP](https://modelcontextprotocol.io) server that lets coding agents (Claude Code, or any MCP client) create, claim, work, and hand off tasks in an [Estuary](https://github.com/krisz4/estuary) task manager.

It is a thin client over Estuary's REST API and never touches a database, so it runs anywhere that can reach the API: your laptop against `localhost`, or every developer's machine against one self-hosted server. The API enforces the workflow rules (claims and leases, versions, what each status requires, agents never marking work done); the server turns them into tools with the API's own input schemas.

You need a running Estuary API. See the [repository README](https://github.com/krisz4/estuary#readme) to start one locally or with Docker.

## Usage

Requires Node.js 20 or later.

```bash
npx -y estuary-mcp
```

It speaks JSON-RPC on stdin/stdout, so on its own it just waits for a client. Diagnostics go to stderr.

### Claude Code

```bash
claude mcp add tasks --scope user \
  -e TASKS_API_URL=http://localhost:4000/api/v1 \
  -- npx -y estuary-mcp
```

The server name goes first because `-e` takes several values and would otherwise swallow it; `--` separates Claude Code's options from the server command. Use `--scope project` to write a shareable `.mcp.json` into one repo instead.

For the tools plus the `task-workflow` skill and a SessionStart reminder of the tasks you hold, install the Estuary Claude Code plugin instead; it runs this package for you. See [Agent integration](https://github.com/krisz4/estuary/blob/main/docs/features/Agent_Integration.md).

### Other MCP clients

Any client that launches stdio servers works. The usual JSON shape:

```json
{
  "mcpServers": {
    "tasks": {
      "command": "npx",
      "args": ["-y", "estuary-mcp"],
      "env": { "TASKS_API_URL": "http://localhost:4000/api/v1" }
    }
  }
}
```

## Configuration

All settings are environment variables, read once at startup. A blank value counts as unset. A malformed value (an actor without `agent:`/`human:`, a URL without `http(s)://`) stops the server at startup with a message naming the variable.

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `TASKS_API_URL` | `http://localhost:4000/api/v1` | API root, **including `/api/v1`**. For a self-hosted server, its public URL, e.g. `https://tasks.example.com/api/v1` |
| `TASKS_ACTOR` | derived per checkout | Who the agent acts as, sent as `X-Actor`: `agent:<name>` or `human:<name>`, lowercase. Unset: `agent:claude-code@<project>`, or `agent:claude-code@<project>/<worktree>` inside a linked git worktree, so parallel sessions in different worktrees hold their claims separately. Two sessions in the same checkout share it, so set it per session if you run that way |
| `TASKS_API_TOKEN` | unset | Sent as `Authorization: Bearer <token>`. Only needed when the API runs with `API_TOKEN` set, and must equal it |
| `TASKS_DEFAULT_PROJECT` | the repository's name | Project for `task_create` / `task_next` calls that name none. Unset: the first valid slug of the repo name of `git remote get-url origin`, the main checkout's directory name, then the project directory's name |

Git runs in `CLAUDE_PROJECT_DIR` (set by Claude Code) or the working directory, with a short timeout; when it is missing or fails, the derivation falls through to the next option.

## Tools

`task_list`, `task_get`, `task_create`, `task_update`, `task_transition`, `task_next`, `task_claim`, `task_heartbeat`, `task_release`, `task_comment`, `task_submit_for_qa`, `task_request_decision`, `task_request_action`, `task_block`, `task_add_dependency`, `task_remove_dependency`, `task_answer_decision`, `task_events`, `task_import_github_issue`, `task_stats`.

What each one calls and returns, the work loop agents follow, and troubleshooting: [docs/features/Agent_Integration.md](https://github.com/krisz4/estuary/blob/main/docs/features/Agent_Integration.md).

## License

[AGPL-3.0-only](https://github.com/krisz4/estuary/blob/main/LICENSE). The license text ships in this package as `LICENSE`.
