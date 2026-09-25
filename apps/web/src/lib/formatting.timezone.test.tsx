import { render, screen } from "@testing-library/react";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Date-only rendering, from a timezone **west** of Greenwich.
 *
 * The whole class of bug is invisible from UTC and from anywhere east of it:
 * this machine sits at UTC+4, where `new Date("2026-08-01")` — UTC midnight —
 * formats as "Aug 1" locally and everything looks fine. It is only west of
 * Greenwich that the same instant lands on the previous day.
 *
 * So the timezone is set **before** the modules under test are imported: the
 * formatters are `Intl.DateTimeFormat` instances built at module scope, and one
 * constructed before this assignment would have captured the ambient zone.
 * That is also why this file exists separately rather than living in
 * `formatting.test.ts`.
 */

/*
  `vi.stubEnv` rather than assigning `process.env.TZ` directly: `apps/web` is
  deliberately browser-typed (`tsconfig.json` carries no `node` types — that is
  why `tests/` exists as a separate, Node-typed directory), so `process` is not
  a name this file may use. The vitest helper is typed by vitest, sets the same
  variable, and undoes it for us.
*/
vi.stubEnv("TZ", "America/New_York");

const { formatDate, formatDateOnly } = await import("@/lib/formatting");
const { TaskFilterBar } = await import("@/features/tasks/TaskFilterBar");
const { DEFAULT_TASK_LIST_PARAMS } = await import("@/pages/tasks-list/useTaskListParams");

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("date-only formatting west of UTC", () => {
  it("is actually running in the timezone this file claims", () => {
    // The guard that keeps every assertion below from passing vacuously. If
    // Node ignored the `TZ` assignment, this fails loudly instead of the suite
    // quietly proving nothing.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("America/New_York");
  });

  it("renders the day the string names, not the instant it parses to", () => {
    const formatted = formatDateOnly("2026-08-01");

    // Locale-independent: no correct rendering of 1 August 2026 contains "31",
    // in any locale, and the failure mode renders "Jul 31".
    expect(formatted).not.toMatch(/31/);
    expect(formatted).toMatch(/\b1\b/);
    expect(formatted).toMatch(/2026/);
  });

  it("is the opposite of what the instant-based formatter does here", () => {
    // Pins *why* the dedicated function exists. `formatDate` is correct for a
    // real instant and wrong for a calendar day, and this is the difference.
    expect(formatDate("2026-08-01")).toMatch(/31/);
    expect(formatDateOnly("2026-08-01")).not.toMatch(/31/);
  });

  it("shows the right day on the rendered chip, not just in the helper", () => {
    render(
      <TaskFilterBar
        params={{ ...DEFAULT_TASK_LIST_PARAMS, createdFrom: "2026-08-01" }}
        facets={undefined}
        onFiltersChange={() => undefined}
        onSortChange={() => undefined}
        onClear={() => undefined}
        activeFilterCount={1}
        isWide={true}
      />,
    );

    const chip = screen.getByRole("button", { name: /remove filter: from/i });
    expect(chip.textContent).not.toMatch(/31/);
    expect(chip.textContent).toMatch(/\b1\b/);
  });
});
