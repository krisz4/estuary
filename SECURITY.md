# Security policy

## Reporting a vulnerability

**Please don't open a public issue for a security problem.** Report it privately through GitHub instead: on the repository's **Security** tab, choose **Report a vulnerability**. That opens a private advisory that only the maintainers can see.

Include what you found, how to reproduce it (a request, a script, or steps in the UI), the version or commit you tested, and the impact as you see it. You'll get an acknowledgement within a few days. The fix and the advisory are coordinated with you, and you're credited unless you'd rather not be.

## Supported versions

Estuary is pre-1.0. Only the latest release gets security fixes. If you run an older version, upgrading is the fix.

## Security model: read this before you deploy

Estuary is built for **a team that trusts each other**, running it on localhost or on a private network. Some of its "missing" security is deliberate, so it helps to know where the line is before you report something.

**By design, not vulnerabilities:**

- **There are no user accounts.** Every request declares who it's from in the `X-Actor` header (`human:dana`, `agent:claude-code@repo`), and the server takes it at face value. Anyone who can reach the API can act as any actor, including as a human, which gets past the "agents stop at `needs_qa`" rule. See [docs/features/Actors.md](docs/features/Actors.md).
- **There is one optional shared secret.** When `API_TOKEN` is set, every `/api/v1` request needs `Authorization: Bearer <API_TOKEN>`. That's the whole access-control model. Everyone who has the token has full read/write access to every task.
- **Without `API_TOKEN` the API is wide open.** That's the default for local development. `apps/api/env.example` binds to `127.0.0.1` for this reason.

**In scope (please report):**

- Getting past `API_TOKEN` when it's set, or getting data out of an instance protected by it.
- Forging a GitHub webhook delivery that the API accepts without a valid `X-Hub-Signature-256`.
- Injection: SQL, or HTML/script injection through task content that runs in the web UI (XSS).
- Leaking the `API_TOKEN`, `GITHUB_TOKEN`, or `GITHUB_WEBHOOK_SECRET` through a response, a log line, or an error message.
- Anything in the MCP server (`estuary-mcp`) or the Claude Code plugin that lets task content execute commands on an agent's machine, or sends the token somewhere other than the configured API.
- Vulnerable dependencies that Estuary actually uses in a way that can be exploited.

## Running it safely

If Estuary is reachable from anything other than your own machine:

1. **Set `API_TOKEN`** to 32 or more random characters, for example `openssl rand -hex 32`.
2. **Put it behind HTTPS.** The token travels in a plain header on every request. The Docker setup has no TLS of its own, so put a reverse proxy, a tunnel, or a platform load balancer in front.
3. **Keep the GitHub token narrow.** Use a fine-grained token with read access only to the repositories you link.
4. **Don't expose it to people you don't trust.** Anyone with the token can rewrite or delete every task. Per-user permissions are out of scope for this project.

Details: [docs/operations/DOCKER.md § Self-hosting](docs/operations/DOCKER.md#self-hosting-agents-against-this-stack) and [docs/engineering/ENVIRONMENT_VARIABLES.md](docs/engineering/ENVIRONMENT_VARIABLES.md).
