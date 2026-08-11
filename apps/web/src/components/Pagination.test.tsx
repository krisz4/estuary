import { type PaginationMeta } from "@helpdesk/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Pagination, paginationRange } from "@/components/Pagination";

const meta = (overrides: Partial<PaginationMeta> = {}): PaginationMeta => ({
  page: 1,
  pageSize: 20,
  total: 63,
  totalPages: 4,
  hasNextPage: true,
  hasPrevPage: false,
  ...overrides,
});

describe("paginationRange", () => {
  it("lists every page when they all fit", () => {
    expect(paginationRange(1, 4)).toEqual([1, 2, 3, 4]);
  });

  it("collapses long runs on either side of the current page", () => {
    expect(paginationRange(6, 12)).toEqual([1, "ellipsis", 5, 6, 7, "ellipsis", 12]);
  });

  it("spells out a gap of exactly one page instead of hiding it", () => {
    // `1 … 3 4 5` would replace a usable button with an ellipsis of the same width.
    expect(paginationRange(4, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never emits a page outside the range", () => {
    expect(paginationRange(1, 1)).toEqual([1]);
  });
});

describe("Pagination", () => {
  const noop = () => undefined;

  it("reports the window it is showing", () => {
    render(
      <Pagination
        meta={meta({ page: 3, hasPrevPage: true })}
        onPageChange={noop}
        onPageSizeChange={noop}
      />,
    );
    expect(screen.getByText("Showing 41–60 of 63 tickets")).toBeInTheDocument();
  });

  it("marks the current page for assistive technology", () => {
    render(
      <Pagination
        meta={meta({ page: 2, hasPrevPage: true })}
        onPageChange={noop}
        onPageSizeChange={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Page 1" })).not.toHaveAttribute("aria-current");
  });

  it("disables the arrows at the ends, driven by meta and not by arithmetic", () => {
    render(<Pagination meta={meta({ page: 1 })} onPageChange={noop} onPageSizeChange={noop} />);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  it("asks for the next page by number", async () => {
    const onPageChange = vi.fn();
    render(
      <Pagination
        meta={meta({ page: 2, hasPrevPage: true })}
        onPageChange={onPageChange}
        onPageSizeChange={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it("does not print a backwards range past the end of the result set", () => {
    // `?page=9` of a 4-page result: the naive arithmetic says "Showing 161–63 of 63".
    render(
      <Pagination
        meta={meta({ page: 9, hasPrevPage: true, hasNextPage: false })}
        onPageChange={noop}
        onPageSizeChange={noop}
      />,
    );
    expect(screen.getByText(/page 9 is past the end/i)).toBeInTheDocument();
    expect(screen.queryByText(/161/)).not.toBeInTheDocument();
  });

  it("does not say 'on 1 pages'", () => {
    // The copy added to fix the backwards-range bug hard-coded its own plural.
    render(
      <Pagination
        meta={meta({ page: 2, total: 5, totalPages: 1, hasNextPage: false, hasPrevPage: true })}
        onPageChange={noop}
        onPageSizeChange={noop}
      />,
    );
    expect(screen.getByText(/on 1 page$/)).toBeInTheDocument();
    expect(screen.queryByText(/1 pages/)).not.toBeInTheDocument();
  });

  it("still pluralises the page count above one", () => {
    render(
      <Pagination
        meta={meta({ page: 9, hasPrevPage: true, hasNextPage: false })}
        onPageChange={noop}
        onPageSizeChange={noop}
      />,
    );
    expect(screen.getByText(/on 4 pages$/)).toBeInTheDocument();
  });

  it("says 'No tickets' rather than 'Showing 0–0 of 0'", () => {
    render(
      <Pagination
        meta={meta({ total: 0, totalPages: 1, hasNextPage: false })}
        onPageChange={noop}
        onPageSizeChange={noop}
      />,
    );
    expect(screen.getByText("No tickets")).toBeInTheDocument();
  });
});
