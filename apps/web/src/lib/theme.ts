/**
 * Theme resolution.
 *
 * Three states, not two: `light`, `dark`, and `system` (the default, which
 * follows `prefers-color-scheme` and keeps following it as the OS flips).
 * Storing "system" as an explicit value rather than as the absence of a value
 * is what makes "go back to matching my OS" a reachable state after a user has
 * once chosen a theme.
 *
 * The same resolution runs as an inline script in `index.html` before first
 * paint — see the comment there. Keep the two in agreement: this module owns
 * the behavior, the inline script is a copy that exists only to beat the paint.
 */

export const THEME_STORAGE_KEY = "helpdesk.theme";

export const THEME_PREFERENCES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = "light" | "dark";

const isThemePreference = (value: unknown): value is ThemePreference =>
  typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** `localStorage` throws in a sandboxed iframe and in some privacy modes. */
const safeRead = (): string | null => {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
};

const safeWrite = (value: string): void => {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    /* Preference simply does not persist. Not worth failing a render over. */
  }
};

export const readStoredTheme = (): ThemePreference => {
  const stored = safeRead();
  return isThemePreference(stored) ? stored : "system";
};

export const systemTheme = (): ResolvedTheme =>
  window.matchMedia(DARK_QUERY).matches ? "dark" : "light";

export const resolveTheme = (preference: ThemePreference): ResolvedTheme =>
  preference === "system" ? systemTheme() : preference;

/**
 * Applies a resolved theme to the document.
 *
 * `color-scheme` is set alongside the class so the browser's own chrome — form
 * controls, scrollbars, and the canvas behind an overscroll — follows too.
 * Without it a dark page keeps white scrollbars.
 */
export const applyTheme = (theme: ResolvedTheme): void => {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
};

export const storeTheme = (preference: ThemePreference): void => {
  safeWrite(preference);
};

/** Subscribes to OS changes. Returns an unsubscribe function. */
export const subscribeToSystemTheme = (listener: (theme: ResolvedTheme) => void): (() => void) => {
  const media = window.matchMedia(DARK_QUERY);
  const handler = (event: MediaQueryListEvent) => listener(event.matches ? "dark" : "light");
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
};
