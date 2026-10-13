import { useQuery } from "@tanstack/react-query";
import { type AgentConnections, type Readiness } from "@estuary/contracts";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, API_BASE_URL } from "@/api/http";
import { queryKeys } from "@/api/queryKeys";
import { Button, Field, Input, Select } from "@/components/ui";
import { ErrorPanel } from "@/components/ErrorPanel";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { formatRelative } from "@/lib/formatting";
import { useSessionStore } from "@/stores/session";

export const ConnectPage = () => {
  useDocumentTitle("Connect an agent");
  const [client, setClient] = useState("codex");
  const [url, setUrl] = useState(() => new URL(API_BASE_URL, window.location.origin).href);
  const [startedAt] = useState(() => Date.now());
  const session = useSessionStore();
  const ready = useQuery({
    queryKey: queryKeys.system.ready(),
    queryFn: () => api.get<Readiness>("/system/ready"),
    retry: false,
  });
  const connections = useQuery({
    queryKey: queryKeys.system.agents(),
    queryFn: () => api.get<AgentConnections>("/system/agents"),
    refetchInterval: 5000,
  });
  const connected =
    connections.data?.data.filter((connection) => Date.parse(connection.lastSeenAt) >= startedAt) ??
    [];
  const env = {
    TASKS_API_URL: url,
    TASKS_CLIENT: client,
    ...(session.apiToken ? { TASKS_API_TOKEN: "<your shared API token>" } : {}),
  };
  const configuration =
    client === "codex"
      ? `[mcp_servers.estuary]\ncommand = "npx"\nargs = ["-y", "estuary-mcp"]\n\n[mcp_servers.estuary.env]\n${Object.entries(
          env,
        )
          .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
          .join("\n")}`
      : JSON.stringify(
          { mcpServers: { estuary: { command: "npx", args: ["-y", "estuary-mcp"], env } } },
          null,
          2,
        );
  const copy = () => {
    void navigator.clipboard
      .writeText(configuration)
      .then(() => toast.success("Configuration copied"))
      .catch(() => toast.error("Select the configuration below and copy it manually"));
  };
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      <header className="max-w-2xl">
        <h1 className="text-3xl font-semibold">Connect an agent</h1>
        <p className="mt-2 text-muted-foreground">
          Bring an agent into Estuary, then run a task through the handoff to your inbox.
        </p>
      </header>
      <ol className="flex flex-col gap-8">
        <li className="flex flex-col gap-4 border-t border-border pt-5">
          <h2 className="text-lg font-semibold">1. Check your instance</h2>
          {ready.isPending ? (
            <p aria-live="polite">Checking the API and database…</p>
          ) : ready.error ? (
            <ErrorPanel
              error={ready.error}
              onRetry={() => void ready.refetch()}
              isRetrying={ready.isFetching}
            />
          ) : (
            <p className="text-success">API connected. Database reachable.</p>
          )}
          <Field
            label="API address"
            help="Use an address reachable from the machine running your agent, ending in /api/v1. The check above tests this browser’s configured instance."
          >
            {(props) => (
              <Input {...props} value={url} onChange={(event) => setUrl(event.target.value)} />
            )}
          </Field>
        </li>
        <li className="flex flex-col gap-4 border-t border-border pt-5">
          <h2 className="text-lg font-semibold">2. Add Estuary to your client</h2>
          <Select
            aria-label="Agent client"
            value={client}
            onValueChange={setClient}
            options={[
              { value: "codex", label: "Codex" },
              { value: "claude-code", label: "Claude Code" },
              { value: "cursor", label: "Cursor" },
              { value: "mcp", label: "Another MCP client" },
            ]}
          />
          <p className="text-sm text-muted-foreground">
            {client === "codex"
              ? "Add this to your Codex MCP configuration."
              : "Add this server entry to your client’s MCP configuration."}{" "}
            Restart the client to load its tools. Each server process gets its own claim session.
          </p>
          <pre
            tabIndex={0}
            aria-label="MCP configuration"
            className="overflow-x-auto rounded-lg border border-border bg-muted p-4 text-xs leading-relaxed"
          >
            {configuration}
          </pre>
          <Button variant="outline" className="self-start" onClick={copy}>
            Copy configuration
          </Button>
          {session.apiToken ? (
            <p className="text-sm text-muted-foreground">
              Replace the token placeholder locally with your shared API token.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              If your instance requires a token, add TASKS_API_TOKEN to the environment above.
            </p>
          )}
          {client === "claude-code" ? (
            <p className="text-sm">
              For the workflow skill and session hooks, install the Estuary Claude Code plugin
              described in the project README.
            </p>
          ) : null}
        </li>
        <li className="flex flex-col gap-4 border-t border-border pt-5">
          <h2 className="text-lg font-semibold">3. Test the connection</h2>
          <p className="text-sm">
            Ask your agent: <strong>“Run Estuary’s task_ping tool.”</strong> A successful request
            appears here.
          </p>
          {connections.error ? (
            <ErrorPanel
              error={connections.error}
              onRetry={() => void connections.refetch()}
              isRetrying={connections.isFetching}
            />
          ) : connected.length === 0 ? (
            <p aria-live="polite" className="text-sm text-muted-foreground">
              Waiting for an agent to contact this instance…
            </p>
          ) : (
            <ul aria-live="polite" className="flex flex-col gap-2">
              {connected.map((connection) => (
                <li
                  key={`${connection.actor}:${connection.sessionId}`}
                  className="break-all text-sm"
                >
                  <strong>{connection.actor}</strong> connected{" "}
                  {formatRelative(connection.lastSeenAt)}
                </li>
              ))}
            </ul>
          )}
        </li>
        <li className="flex flex-col gap-4 border-t border-border pt-5">
          <h2 className="text-lg font-semibold">4. Complete your first handoff</h2>
          <p className="max-w-2xl text-sm">
            Create a small task with clear acceptance criteria. Ask the agent to claim it, keep its
            lease alive with task_heartbeat, record a checkpoint if it stops, and submit the
            finished work with test evidence using task_submit_for_qa. Open your inbox to verify it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to="/tasks/new?status=todo">Create a task</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/inbox">Open the inbox</Link>
            </Button>
          </div>
        </li>
      </ol>
    </div>
  );
};
