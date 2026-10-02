import { type TaskLink } from "@estuary/contracts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TaskLinks } from "@/features/tasks/TaskLinks";
import { mockApi, renderInProviders } from "@/test/harness";

const links: TaskLink[] = [{ label: "PR #12", url: "https://github.com/acme/widgets/pull/12" }];

describe("TaskLinks — GitHub status", () => {
  it("renders no badge when the integration is disabled (the harness default)", async () => {
    mockApi({});
    renderInProviders(<TaskLinks links={links} taskId={42} />);

    expect(await screen.findByRole("link", { name: /PR #12/ })).toBeInTheDocument();
    expect(screen.queryByText("Open")).not.toBeInTheDocument();
  });

  it("asks for no per-task GitHub status without a taskId", async () => {
    const { requests } = mockApi({});
    renderInProviders(<TaskLinks links={links} />);

    await screen.findByRole("link", { name: /PR #12/ });
    // The integration-status check still fires (it is what every page gates
    // the "Import issue" button and the badges on); only the per-task status
    // request, which needs a task id, must not.
    expect(requests.some((r) => /\/tasks\/\d+\/github$/.test(r.url.pathname))).toBe(false);
  });

  it("shows the live state badge and a checks dot when the integration is enabled", async () => {
    mockApi({
      "GET /integrations/github": () => ({
        body: {
          enabled: true,
          tokenConfigured: true,
          webhookConfigured: true,
          webhookPath: "/integrations/github/webhook",
        },
      }),
      "GET /tasks/42/github": () => ({
        body: {
          data: [
            {
              url: links[0]!.url,
              kind: "pull",
              repo: "acme/widgets",
              number: 12,
              title: "Add widgets",
              state: "open",
              checks: "success",
              error: null,
              fetchedAt: "2026-08-01T10:00:00.000Z",
            },
          ],
        },
      }),
    });

    renderInProviders(<TaskLinks links={links} taskId={42} />);

    expect(await screen.findByText("Open")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Checks passing" })).toBeInTheDocument();
  });

  it("shows a quiet unavailable message for a link GitHub could not resolve", async () => {
    mockApi({
      "GET /integrations/github": () => ({
        body: {
          enabled: true,
          tokenConfigured: true,
          webhookConfigured: false,
          webhookPath: "/integrations/github/webhook",
        },
      }),
      "GET /tasks/42/github": () => ({
        body: {
          data: [
            {
              url: links[0]!.url,
              kind: "pull",
              repo: "acme/widgets",
              number: 12,
              title: null,
              state: null,
              checks: null,
              error: "not found",
              fetchedAt: "2026-08-01T10:00:00.000Z",
            },
          ],
        },
      }),
    });

    renderInProviders(<TaskLinks links={links} taskId={42} />);

    expect(await screen.findByText("GitHub status unavailable")).toBeInTheDocument();
  });

  it("offers a quiet inline retry when the status request fails, without breaking the page", async () => {
    const user = userEvent.setup();
    let calls = 0;
    mockApi({
      "GET /integrations/github": () => ({
        body: {
          enabled: true,
          tokenConfigured: true,
          webhookConfigured: false,
          webhookPath: "/integrations/github/webhook",
        },
      }),
      "GET /tasks/42/github": () => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 502,
            body: { error: { code: "GITHUB_UNAVAILABLE", message: "x", requestId: "r1" } },
          };
        }
        return { body: { data: [] } };
      },
    });

    renderInProviders(<TaskLinks links={links} taskId={42} />);

    const retry = await screen.findByRole("button", { name: /retry github status/i });
    // The rest of the page — the link itself — is unaffected by the failure.
    expect(screen.getByRole("link", { name: /PR #12/ })).toBeInTheDocument();

    await user.click(retry);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /retry github status/i }),
      ).not.toBeInTheDocument(),
    );
  });
});
