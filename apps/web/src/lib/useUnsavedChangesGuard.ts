import { useCallback, useEffect, useRef } from "react";
import { useBlocker, type Blocker } from "react-router-dom";

/**
 * Stops a half-typed form being thrown away by a stray click or a closed tab.
 *
 * Two exits have to be covered and they are covered by different mechanisms:
 *
 * - **In-app navigation** (the header link, a browser Back) goes through the
 *   router, so `useBlocker` catches it. This needs a data router, which
 *   `createBrowserRouter` gives us.
 * - **Leaving the site** (reload, tab close, typed URL) never reaches the
 *   router, so it needs `beforeunload`. The browser shows its own dialog and
 *   ignores custom text; that is fine, and it is the only thing available.
 *
 * ## Why refs and not props
 *
 * Both predicates are read at *event time*, which is not render time. After a
 * successful submit the page calls `allowNavigation()` and navigates in the same
 * tick — a `useBlocker(isDirty)` boolean captured in the last render would still
 * say "dirty" and block the navigation the user just earned. A ref is written
 * synchronously, so the predicate sees the new value on the very next event.
 *
 * `useBlocker`'s function form is what makes this work at all: react-router
 * calls it per navigation rather than reading a value captured at subscribe
 * time.
 */
export type UnsavedChangesGuard = {
  /** `blocked` while a navigation is being held. Drive a confirm dialog off it. */
  blocker: Blocker;
  /** Call immediately before an intentional navigation (a successful submit). */
  allowNavigation: () => void;
};

export const useUnsavedChangesGuard = (isDirty: boolean): UnsavedChangesGuard => {
  const isDirtyRef = useRef(isDirty);
  const allowRef = useRef(false);

  // Mirrored in an effect rather than assigned during render: writing a ref
  // while rendering is a React rule violation (and a real hazard under
  // concurrent rendering, where a render can be thrown away). Effects flush
  // before any user event can fire, so the predicate below never reads a stale
  // value in practice.
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!isDirtyRef.current || allowRef.current) return;
      // `preventDefault()` is the spec'd opt-in; `returnValue` is what older
      // engines still read. Both, because neither alone covers every browser.
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const blocker = useBlocker(useCallback(() => isDirtyRef.current && !allowRef.current, []));

  const allowNavigation = useCallback(() => {
    allowRef.current = true;
  }, []);

  return { blocker, allowNavigation };
};
