import { formatReference, type TaskSummary } from "@helpdesk/contracts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePage, makeSummary, makeTask, mockApi, renderInProviders, type MockRequest } from "@/test/harness";
import { NeedsYouSection } from "@/pages/tasks-map/sections/NeedsYouSection";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const posted = (requests: MockRequest[], suffix: string) =>
  requests.filter((request) => request.method === "POST" && request.url.pathname.endsWith(suffix));

const task = (id: number, overrides: Partial<TaskSummary>): TaskSummary =>
  makeSummary({ id, reference: formatReference(id), title: `Task ${id}`, ...overrides });

const qaTask = task(9, {
  status: "needs_qa",
  title: "Ship the export throttle",
  statusNote: "Rate limiter is in, tested locally.",
});

/**
 * The Map's "Needs you" section reuses `InboxItem` wholesale — this is the
 * "the needs-you section's inline actions must call the correct mutations"
 * test the coordinator asked for, proving the reuse is real (a click here
 * drives the same `POST /tasks/:id/transition` the Inbox page's own test
 * asserts) rather than a lookalike copy.
 */
beforeEach(() => {
  vi.clearAllMocks();
});

describe("NeedsYouSection", () => {
  it("approving a QA item posts the real transition, through the reused InboxItem", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tasks": () => ({ body: makePage([qaTask], 100) }),
      "POST /tasks/9/transition": () => ({ body: makeTask({ id: 9, status: "done" }) }),
    });
    renderInProviders(<NeedsYouSection project={[]} projectOrder={[]} />);

    await user.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => expect(posted(requests, "/transition")).toHaveLength(1));
    expect(posted(requests, "/transition")[0]?.body).toEqual({ to: "done" });
  });

  it("shows the empty state when nothing needs a human", async () => {
    mockApi({ "GET /tasks": () => ({ body: makePage([], 0) }) });
    renderInProviders(<NeedsYouSection project={[]} projectOrder={[]} />);
    expect(await screen.findByText("Nothing needs you.")).toBeInTheDocument();
  });

  it("rows start collapsed, expand on click into the full InboxItem, and collapse again on a second click", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /tasks": () => ({ body: makePage([qaTask], 100) }) });
    renderInProviders(<NeedsYouSection project={[]} projectOrder={[]} />);

    await screen.findByText("Ship the export throttle");
    // Collapsed: the row shows the title and a quick action, but not the
    // expanded panel's acceptance-criteria/"Send back" controls yet.
    expect(screen.queryByRole("button", { name: "Send back" })).not.toBeInTheDocument();

    const row = screen.getByRole("button", { name: /Ship the export throttle/ });
    expect(row).toHaveAttribute("aria-expanded", "false");

    await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("button", { name: "Send back" })).toBeInTheDocument();

    await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Send back" })).not.toBeInTheDocument();
  });

  it("only expands one row at a time", async () => {
    const user = userEvent.setup();
    const actionTask = task(11, {
      status: "needs_user_action",
      title: "Rotate the staging key",
      statusNote: "Rotate it in 1Password.",
    });
    mockApi({ "GET /tasks": () => ({ body: makePage([qaTask, actionTask], 100) }) });
    renderInProviders(<NeedsYouSection project={[]} projectOrder={[]} />);

    await screen.findByText("Ship the export throttle");
    const qaRow = screen.getByRole("button", { name: /Ship the export throttle/ });
    const actionRow = screen.getByRole("button", { name: /Rotate the staging key/ });

    await user.click(qaRow);
    expect(qaRow).toHaveAttribute("aria-expanded", "true");

    await user.click(actionRow);
    expect(actionRow).toHaveAttribute("aria-expanded", "true");
    expect(qaRow).toHaveAttribute("aria-expanded", "false");
  });

  it("expands on Enter as well as click", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /tasks": () => ({ body: makePage([qaTask], 100) }) });
    renderInProviders(<NeedsYouSection project={[]} projectOrder={[]} />);

    const row = await screen.findByRole("button", { name: /Ship the export throttle/ });
    row.focus();
    await user.keyboard("{Enter}");
    expect(row).toHaveAttribute("aria-expanded", "true");
  });
});
