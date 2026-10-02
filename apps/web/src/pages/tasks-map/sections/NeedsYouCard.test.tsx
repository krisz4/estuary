import { formatReference, type TaskSummary } from "@estuary/contracts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeSummary,
  makeTask,
  mockApi,
  renderInProviders,
  type MockRequest,
} from "@/test/harness";
import { NeedsYouCard } from "@/pages/tasks-map/sections/NeedsYouCard";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const posted = (requests: MockRequest[], suffix: string) =>
  requests.filter((request) => request.method === "POST" && request.url.pathname.endsWith(suffix));

const task = (overrides: Partial<TaskSummary>): TaskSummary =>
  makeSummary({
    id: 9,
    reference: formatReference(9),
    title: "Ship the export throttle",
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * The hero rail's compact card — not a stretched `InboxItem`. Covers the
 * three kinds' one-click primary action and the "open the real task" escape
 * hatch, which is all `onOpen` needs to do here (the drawer itself is
 * `TasksMapPage`'s concern).
 */
describe("NeedsYouCard", () => {
  it("a decision's recommended option is the one-click primary action", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "POST /tasks/9/decision/answer": () => ({ body: makeTask({ id: 9, status: "todo" }) }),
    });
    const onOpen = vi.fn();
    renderInProviders(
      <NeedsYouCard
        task={task({
          status: "needs_user_decision",
          openDecision: {
            id: 1,
            taskId: 9,
            status: "open",
            question: "Token bucket or leaky bucket?",
            context: null,
            options: [{ label: "Token bucket" }, { label: "Leaky bucket" }],
            recommendedOption: "Token bucket",
            requestedBy: "agent:claude-code",
            choice: null,
            note: null,
            answeredBy: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            answeredAt: null,
          },
        })}
        onOpen={onOpen}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Token bucket" }));
    await waitFor(() => expect(posted(requests, "/decision/answer")).toHaveLength(1));
    expect(posted(requests, "/decision/answer")[0]?.body).toEqual({ choice: "Token bucket" });

    await user.click(screen.getByRole("button", { name: "Other…" }));
    expect(onOpen).toHaveBeenCalledWith(9);
  });

  it("a QA item's Approve posts the transition directly", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "POST /tasks/9/transition": () => ({ body: makeTask({ id: 9, status: "done" }) }),
    });
    renderInProviders(
      <NeedsYouCard
        task={task({ status: "needs_qa", statusNote: "Tested locally." })}
        onOpen={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posted(requests, "/transition")).toHaveLength(1));
    expect(posted(requests, "/transition")[0]?.body).toEqual({ to: "done" });
  });

  it("an action item's 'Done, hand back' hands it back to To do", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "POST /tasks/9/transition": () => ({ body: makeTask({ id: 9, status: "todo" }) }),
    });
    renderInProviders(
      <NeedsYouCard
        task={task({ status: "needs_user_action", statusNote: "Rotate the key." })}
        onOpen={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Done, hand back" }));
    await waitFor(() => expect(posted(requests, "/transition")).toHaveLength(1));
    expect(posted(requests, "/transition")[0]?.body).toMatchObject({ to: "todo" });
  });

  it("clicking the title opens the task, without calling any mutation", async () => {
    const user = userEvent.setup();
    mockApi({});
    const onOpen = vi.fn();
    renderInProviders(<NeedsYouCard task={task({ status: "needs_qa" })} onOpen={onOpen} />);

    await user.click(screen.getByRole("button", { name: "Ship the export throttle" }));
    expect(onOpen).toHaveBeenCalledWith(9);
  });
});
