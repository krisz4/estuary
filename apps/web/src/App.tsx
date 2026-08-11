import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";
import { queryClient } from "@/api/queryClient";
import { SM_BREAKPOINT_QUERY, useMediaQuery } from "@/lib/useMediaQuery";
import { useTheme } from "@/lib/useTheme";
import { router } from "@/router";

/**
 * Providers, outermost to innermost, per `docs/pages/App_Shell.md`.
 *
 * `QueryClientProvider` wraps the router rather than the other way round: a
 * route element must be able to call `useQuery`, and the client has to outlive
 * every navigation for the cache to be worth having.
 *
 * The `ErrorBoundary` is *not* here. It lives inside `AppLayout`, below the
 * header, so a render crash leaves the user with working navigation instead of
 * an empty document.
 */
export const App = () => {
  /*
    Bottom-right on desktop, top-centre on mobile: a bottom toast on a phone
    sits under the thumb and covers the sticky form actions stage 12 adds.

    Sonner has no responsive `position` — it is one value for the whole
    document, and `mobileOffset` only shifts the toast within whatever position
    is already set. So the breakpoint has to be read in JS. This is the rare
    case where that is correct rather than lazy: the toast outlet is portalled
    to the body and its placement is a prop, not a class.
  */
  const isDesktop = useMediaQuery(SM_BREAKPOINT_QUERY);

  /*
    Sonner cannot be themed from our stylesheet. It injects its own <style> at
    runtime, unlayered and therefore ahead of everything in `@layer`, and its
    palette is selected by `[data-sonner-theme='light'|'dark']` — an attribute
    it stamps from this prop. Its default is `"light"`, so leaving the prop off
    renders every toast in the light palette on a dark page. It has to be told,
    and it has to be told the *resolved* theme, not the preference: "system"
    means nothing to Sonner.
  */
  const { resolved } = useTheme();

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />

      {/*
        `richColors` gives success/error toasts Sonner's own filled palettes,
        which do follow `theme`. Only the neutral toast is restyled by us, via
        the `--normal-*` block in index.css — see the note there about why that
        block sits outside `@layer`.

        `text-sm!` carries the important modifier deliberately: Sonner's
        unlayered rules outrank any layered utility, so a plain `text-sm` is
        silently dropped.
      */}
      <Toaster
        theme={resolved}
        position={isDesktop ? "bottom-right" : "top-center"}
        richColors
        closeButton
        toastOptions={{ className: "text-sm!" }}
      />
    </QueryClientProvider>
  );
};
