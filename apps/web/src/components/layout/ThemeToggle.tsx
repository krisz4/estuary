import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui";
import { applyTheme } from "@/lib/theme";
import { useTheme } from "@/lib/useTheme";
import type { ThemePreference } from "@/lib/theme";

const ICONS: Record<ThemePreference, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

const LABELS: Record<ThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

/**
 * Cycles light → dark → system.
 *
 * A three-state cycle rather than a two-state switch because "follow my OS" is
 * the default, and a plain toggle makes it unreachable once the user has picked
 * anything. The current state is in the `aria-label`, not only in the icon, so
 * the control is not colour-and-glyph only.
 *
 * The state itself lives in `useTheme`, not here — `<Toaster>` needs the same
 * value, and a theme owned by one button is a theme the rest of the app cannot
 * see.
 */
export const ThemeToggle = () => {
  const { preference, resolved, cycle } = useTheme();

  // The inline script in index.html already applied this before first paint, so
  // on mount it is a no-op; it exists to re-apply after a hot reload, and to
  // keep the document honest if the store is ever initialised without a write.
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const Icon = ICONS[preference];

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label={`Theme: ${LABELS[preference]}. Change theme.`}
      title={`Theme: ${LABELS[preference]}`}
      data-theme-preference={preference}
    >
      <Icon aria-hidden="true" />
    </Button>
  );
};
