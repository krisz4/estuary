import { type Verification } from "@estuary/contracts";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VerificationPanel } from "@/features/tasks/VerificationPanel";

const base = {
  commit: "a".repeat(40),
  checks: [{ command: "pnpm test", result: "passed" as const }],
  criteria: [{ criterion: "Exports are throttled.", result: "passed" as const }],
};

describe("VerificationPanel — QA evidence", () => {
  it("renders device scenarios, notes, photo thumbnails and other evidence links", () => {
    const evidence: Verification = {
      ...base,
      qa: {
        method: "device",
        target: "iPhone 16 simulator",
        scenarios: [{ scenario: "Export on 360px", result: "passed" }],
        notes: "Checked dark mode too.",
        evidence: [
          { kind: "photo", url: "https://example.com/a.png", description: "Export dialog" },
          { kind: "photo", url: "https://example.com/b.png" },
          { kind: "video", url: "https://example.com/run.mp4", description: "Full run" },
          { kind: "doc", url: "https://example.com/report.pdf" },
          { kind: "link", url: "https://example.com/pr" },
        ],
      },
    };
    render(<VerificationPanel evidence={evidence} />);

    expect(screen.getByText("iPhone 16 simulator")).toBeInTheDocument();
    expect(screen.getByText("Checked dark mode too.")).toBeInTheDocument();

    const photo = screen.getByAltText("Export dialog");
    expect(photo).toHaveAttribute("loading", "lazy");
    const photoLink = photo.closest("a")!;
    expect(photoLink).toHaveAttribute("href", "https://example.com/a.png");
    expect(photoLink).toHaveAttribute("target", "_blank");
    expect(photoLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByAltText("QA photo")).toBeInTheDocument();

    const links = within(screen.getByRole("list", { name: "QA evidence links" }));
    expect(links.getByRole("link", { name: /Video/ })).toHaveAttribute(
      "href",
      "https://example.com/run.mp4",
    );
    expect(links.getByText(/Full run/)).toBeInTheDocument();
    expect(links.getByRole("link", { name: /Document/ })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    expect(links.getByRole("link", { name: /Link/ })).toBeInTheDocument();
  });

  it("renders the not-needed reason, and drops a non-http url defensively", () => {
    const evidence = {
      ...base,
      qa: {
        method: "not_needed",
        reason: "Docs-only change.",
        evidence: [{ kind: "link", url: "javascript:alert(1)" }],
      },
    } as Verification;
    render(<VerificationPanel evidence={evidence} />);

    expect(screen.getByText(/No device check needed/)).toBeInTheDocument();
    expect(screen.getByText(/Docs-only change/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("says so when there is no evidence", () => {
    render(<VerificationPanel evidence={null} />);
    expect(screen.getByText(/No verification evidence/)).toBeInTheDocument();
  });
});
