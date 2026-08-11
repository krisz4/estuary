import { useCallback, useSyncExternalStore } from "react";
import {
  applyTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  subscribeToSystemTheme,
  THEME_PREFERENCES,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

/**
 * The app's theme, as one store rather than one component's state.
 *
 * It started inside `ThemeToggle`, which was wrong in a way worth recording:
 * the toggle is not the only consumer. Sonner's `<Toaster>` needs the *resolved*
 * theme as a prop — its stylesheet is injected unlayered at runtime, so it
 * cannot be restyled from our CSS and has to be told which palette to use. With
 * the state private to the toggle, `<Toaster>` silently kept Sonner's default
 * (`theme="light"`) and every toast rendered white-on-white in dark mode, while
 * a token test that only ever inspected `index.css` stayed green.
 *
 * So: one module owns the preference, applies it to the document, and both
 * `ThemeToggle` and `App` read from here.
 *
 * `useSyncExternalStore` rather than context — there is no tree to scope this
 * to, the value is genuinely global, and it avoids wrapping the router in yet
 * another provider.
 */

type ThemeState = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
};

const listeners = new Set<() => void>();

/**
 * Lazily initialised: this module is imported by component modules that a
 * node-environment test may load without a DOM, and reading `matchMedia` at
 * module scope would throw there rather than at the point of use.
 */
let state: ThemeState | null = null;

const currentState = (): ThemeState => {
  if (state === null) {
    const preference = readStoredTheme();
    state = { preference, resolved: resolveTheme(preference) };
  }
  return state;
};

const setState = (next: ThemeState): void => {
  state = next;
  applyTheme(next.resolved);
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);

  // While following the system, an OS flip must move the resolved theme. With an
  // explicit choice stored it must not — that is the whole point of storing one.
  const unsubscribeSystem = subscribeToSystemTheme((systemTheme) => {
    const { preference } = currentState();
    if (preference !== "system") return;
    setState({ preference, resolved: systemTheme });
  });

  return () => {
    listeners.delete(listener);
    unsubscribeSystem();
  };
};

/** Server/`getServerSnapshot`: no DOM to read, and light is the safe default. */
const emptySnapshot: ThemeState = { preference: "system", resolved: "light" };

export type UseThemeResult = ThemeState & {
  setPreference: (preference: ThemePreference) => void;
  /** light → dark → system → light. */
  cycle: () => void;
};

export const useTheme = (): UseThemeResult => {
  const { preference, resolved } = useSyncExternalStore(
    subscribe,
    currentState,
    () => emptySnapshot,
  );

  const setPreference = useCallback((next: ThemePreference) => {
    storeTheme(next);
    setState({ preference: next, resolved: resolveTheme(next) });
  }, []);

  const cycle = useCallback(() => {
    const index = THEME_PREFERENCES.indexOf(currentState().preference);
    setPreference(THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length] ?? "system");
  }, [setPreference]);

  return { preference, resolved, setPreference, cycle };
};
