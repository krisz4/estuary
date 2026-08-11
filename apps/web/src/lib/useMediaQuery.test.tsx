import { act, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { liveMediaQueryListenerCount, setViewportWidth } from "../../vitest.setup";
import { MD_BREAKPOINT_QUERY, useMediaQuery } from "@/lib/useMediaQuery";

/**
 * Guards on the jsdom `matchMedia` stub itself.
 *
 * `useSyncExternalStore` calls `getSnapshot` — and therefore `matchMedia(query)`
 * — on every render, so anything the stub allocates per call is allocated per
 * render. Stage 13 adds many more component tests against this stub, and a cost
 * that grows with render count is the kind that only shows up once it is
 * expensive to find.
 */
const Probe = () => {
  const isWide = useMediaQuery(MD_BREAKPOINT_QUERY);
  const [, setTick] = useState(0);
  return (
    <button type="button" onClick={() => setTick((value) => value + 1)}>
      {isWide ? "wide" : "narrow"}
    </button>
  );
};

describe("useMediaQuery against the jsdom stub", () => {
  it("reports the breakpoint and follows a resize", () => {
    setViewportWidth(1280);
    const { getByRole } = render(<Probe />);
    expect(getByRole("button")).toHaveTextContent("wide");

    // Inside `act`: the store notifies synchronously, but React still has to
    // flush the re-render it schedules.
    act(() => setViewportWidth(360));
    expect(getByRole("button")).toHaveTextContent("narrow");
  });

  it("registers one resize handler for the file, not one per render", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const { rerender, unmount } = render(<Probe />);

    for (let index = 0; index < 5; index += 1) rerender(<Probe />);

    const resizeRegistrations = addEventListener.mock.calls.filter(
      ([type]) => type === "resize",
    ).length;
    // Written as an implementation-independent count so it fails against the
    // per-call version of the stub, which registered one handler per render.
    expect(resizeRegistrations).toBeLessThanOrEqual(1);

    addEventListener.mockRestore();
    unmount();
  });

  it("holds one subscription per mounted hook and releases it on unmount", () => {
    const before = liveMediaQueryListenerCount();
    const { rerender, unmount } = render(<Probe />);

    for (let index = 0; index < 5; index += 1) rerender(<Probe />);
    expect(liveMediaQueryListenerCount()).toBe(before + 1);

    unmount();
    expect(liveMediaQueryListenerCount()).toBe(before);
  });
});
