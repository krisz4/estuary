/**
 * How often screens that show agent-driven state re-ask the server.
 *
 * Agents write to this app all day through the MCP server, and there are no
 * websockets (`docs/features/Task_Workflow_API.md` § Events) — so the list, the
 * map, the inbox badge, the detail page and its activity timeline poll.
 *
 * Fifteen seconds is "an agent's change shows up while you are still looking
 * at the screen" without turning an idle tab into load. TanStack Query pauses
 * the interval while the tab is hidden (`refetchIntervalInBackground` defaults
 * to `false`), so a forgotten tab costs nothing.
 *
 * Polling is not a substitute for invalidation: a write made *in this browser*
 * still invalidates its keys, so the user sees their own change immediately
 * rather than up to fifteen seconds later.
 */
export const POLL_INTERVAL_MS = 15_000;
