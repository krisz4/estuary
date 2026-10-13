import { expect, test } from "@playwright/test";
import { API_BASE_URL } from "./env";
import { createTask, transitionTask, uniqueProject, uniqueTitle } from "./helpers";

test("connects an agent and keeps setup readable on a phone", async ({ page, request }) => {
  await page.goto("/connect");
  await expect(page.getByText("API connected. Database reachable.")).toBeVisible();
  await expect(page.getByLabel("MCP configuration")).toContainText("[mcp_servers.estuary]");
  const ping = await request.get(`${API_BASE_URL}/system/ready`, {
    headers: { "X-Actor": "agent:setup-e2e", "X-Claim-Session": `setup-${Date.now()}` },
  });
  expect(ping.ok()).toBe(true);
  await expect(page.getByText("agent:setup-e2e", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "/private/tmp/estuary-connect-mobile.png", fullPage: true });
});

test("reviews evidence and snoozes an external blocker through the inbox", async ({
  page,
  request,
}) => {
  const project = uniqueProject("supervision");
  const title = uniqueTitle("verified");
  const task = await createTask(request, {
    title,
    description: "Check the review workflow",
    status: "todo",
    project,
    acceptanceCriteria: "The handoff includes evidence",
  });
  await transitionTask(request, task.id, {
    to: "needs_qa",
    summary: "Checked the handoff",
    verification: {
      commit: "abc1234",
      checks: [{ command: "pnpm test", result: "passed" }],
      criteria: [{ criterion: "The handoff includes evidence", result: "passed" }],
    },
  });
  const blocked = await createTask(request, {
    title: uniqueTitle("vendor"),
    description: "Waiting on an external vendor",
    status: "todo",
    project,
    acceptanceCriteria: "Vendor has supplied access",
  });
  await transitionTask(request, blocked.id, { to: "blocked", reason: "Vendor must supply access" });
  await page.goto(`/inbox?project=${project}&sort=attentionSince:asc`);
  await page.getByText("Routine hand-off — view the summary").click();
  await expect(page.getByLabel("Verification evidence")).toContainText("abc1234");
  await page.getByRole("button", { name: "Snooze for 24 hours" }).click();
  await expect(page.getByText(blocked.title, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Show snoozed blockers" }).click();
  await expect(page.getByText(blocked.title, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Return to inbox" }).click();
  await expect(page.getByText("No snoozed blockers", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show active inbox" }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  const saved = await request.get(`${API_BASE_URL}/tasks/${task.id}`);
  expect((await saved.json()).verification.commit).toBe("abc1234");
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByLabel("Verification evidence")).toContainText("abc1234");
});
