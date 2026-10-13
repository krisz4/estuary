import { TASK_STATUSES } from "@estuary/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { STATUS_TONES, StatusBadge } from "@/features/tasks/StatusBadge";
import {
  TASK_STATUS_DESCRIPTIONS,
  TASK_STATUS_LABELS,
  manualStatusOptions,
} from "@/lib/formatting";

describe("StatusBadge", () => {
  it.each(TASK_STATUSES)("labels, describes and tones %s", (status) => {
    expect(TASK_STATUS_LABELS[status]).toBeTruthy();
    expect(TASK_STATUS_DESCRIPTIONS[status]).toBeTruthy();
    expect(STATUS_TONES[status]).toBeTruthy();
    render(<StatusBadge status={status} />);
    expect(screen.getByText(TASK_STATUS_LABELS[status])).toBeInTheDocument();
  });

  it("renders verified green, distinct from Needs QA's attention tone", () => {
    expect(TASK_STATUS_LABELS.verified).toBe("Verified");
    expect(STATUS_TONES.verified).toBe("success");
    expect(STATUS_TONES.needs_qa).toBe("attention");
  });

  it("keeps verified out of the manual picker", () => {
    expect(manualStatusOptions.map((o) => o.value)).not.toContain("verified");
    expect(manualStatusOptions).toHaveLength(TASK_STATUSES.length - 1);
  });
});
