import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { ConnectPage } from "./ConnectPage";
import { mockApi, renderRoute } from "@/test/harness";

it("checks readiness, provides client configuration, and detects agent activity", async () => {
  mockApi({
    "GET /system/ready": () => ({ body: { status: "ok", database: "reachable" } }),
    "GET /system/agents": () => ({
      body: {
        data: [
          {
            actor: "agent:codex",
            sessionId: "setup-session",
            lastSeenAt: new Date(Date.now() + 1000).toISOString(),
          },
        ],
      },
    }),
  });
  renderRoute({
    routes: [{ path: "/connect", element: <ConnectPage /> }],
    initialEntries: ["/connect"],
  });
  expect(await screen.findByText("API connected. Database reachable.")).toBeInTheDocument();
  expect(screen.getByLabelText("MCP configuration")).toHaveTextContent("[mcp_servers.estuary]");
  expect(await screen.findByText("agent:codex")).toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Agent client" }));
  await user.click(screen.getByRole("option", { name: "Cursor" }));
  await waitFor(() =>
    expect(screen.getByLabelText("MCP configuration")).toHaveTextContent(
      '"TASKS_CLIENT": "cursor"',
    ),
  );
  expect(screen.getByRole("link", { name: "Create a task" })).toHaveAttribute(
    "href",
    "/tasks/new?status=todo",
  );
});

it("reports a readiness failure and keeps setup instructions available", async () => {
  mockApi({
    "GET /system/ready": () => ({
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "Unavailable", requestId: "ready" } },
    }),
    "GET /system/agents": () => ({ body: { data: [] } }),
  });
  renderRoute({
    routes: [{ path: "/connect", element: <ConnectPage /> }],
    initialEntries: ["/connect"],
  });
  expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(screen.queryByText("API connected. Database reachable.")).not.toBeInTheDocument();
  expect(screen.getByLabelText("MCP configuration")).toBeInTheDocument();
});
