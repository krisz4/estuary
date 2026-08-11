import { describe, expect, it, vi } from "vitest";
import { ApiClientError } from "@/api/http";
import { applyServerValidationErrors } from "@/lib/serverErrors";

const FIELDS = ["title", "description", "assignee"] as const;

const validationError = (details: unknown) =>
  new ApiClientError({ code: "VALIDATION_ERROR", message: "Invalid", details, status: 422 });

describe("applyServerValidationErrors", () => {
  it("sets one error per known field and returns nothing for the summary", () => {
    const setError = vi.fn();

    const summary = applyServerValidationErrors(
      validationError({ title: ["Too short"], assignee: ["Too long"] }),
      FIELDS,
      setError,
    );

    expect(summary).toEqual([]);
    expect(setError).toHaveBeenCalledTimes(2);
    expect(setError).toHaveBeenNthCalledWith(
      1,
      "title",
      { type: "server", message: "Too short" },
      { shouldFocus: false },
    );
    expect(setError).toHaveBeenNthCalledWith(
      2,
      "assignee",
      { type: "server", message: "Too long" },
      { shouldFocus: false },
    );
  });

  /**
   * `shouldFocus` focuses a **registered input ref**, and three of the form's
   * controls are Radix Selects that have none — so spending the flag on the
   * first matching key aimed focus at nothing whenever that key was a select.
   * `TicketForm` focuses the first rendered `aria-invalid` instead; this
   * function must not compete with it.
   */
  it("never asks setError to move focus", () => {
    const setError = vi.fn();

    applyServerValidationErrors(
      validationError({ assignee: ["Too long"], title: ["Too short"] }),
      FIELDS,
      setError,
    );

    expect(setError).toHaveBeenCalledTimes(2);
    for (const call of setError.mock.calls) expect(call[2]).toEqual({ shouldFocus: false });
  });

  it("applies messages in FORM order, not in server order", () => {
    const setError = vi.fn();

    applyServerValidationErrors(
      // Server names `assignee` first; the form renders `title` first.
      validationError({ assignee: ["Too long"], title: ["Too short"] }),
      FIELDS,
      setError,
    );

    expect(setError.mock.calls.map((call) => call[0])).toEqual(["title", "assignee"]);
  });

  it("routes `_` to the summary instead of setError", () => {
    const setError = vi.fn();

    const summary = applyServerValidationErrors(
      validationError({ _: ['Unrecognized key: "id"'] }),
      FIELDS,
      setError,
    );

    expect(summary).toEqual(['Unrecognized key: "id"']);
    expect(setError).not.toHaveBeenCalled();
  });

  it("routes a field this form does not render to the summary", () => {
    const setError = vi.fn();

    const summary = applyServerValidationErrors(
      validationError({ resolvedAt: ["Not accepted"] }),
      FIELDS,
      setError,
    );

    expect(summary).toEqual(["Not accepted"]);
    expect(setError).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-validation code", new ApiClientError({ code: "NOT_FOUND", message: "x", status: 404 })],
    ["a plain Error", new Error("network")],
    ["a malformed details payload", validationError("not an object")],
    ["undefined", undefined],
  ])("does nothing for %s", (_label, error) => {
    const setError = vi.fn();
    expect(applyServerValidationErrors(error, FIELDS, setError)).toEqual([]);
    expect(setError).not.toHaveBeenCalled();
  });
});
