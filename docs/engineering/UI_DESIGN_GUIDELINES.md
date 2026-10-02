# UI design guidelines

The brief asks for "decent" and "responsive on a mobile phone". That is the bar: a calm, dense, obviously-functional tool, correct at 360px. Not a design showcase.

## Stack

Tailwind CSS + a small set of local primitives in `src/components/ui/` (Button, Input, Textarea, Select, Badge, Dialog, Skeleton, and `Field` — the render prop that owns every form control's label / `aria-invalid` / `aria-describedby` wiring), Radix for dialog/select behavior, Sonner for toasts, `lucide-react` for icons.

No component library theme to fight, and no bespoke design system to maintain.

## Tokens

Defined as CSS variables in `src/index.css` and mapped to Tailwind utilities in the `@theme inline` block of that same file. Use the token, never a raw hex.

There is **no `tailwind.config.ts`**: Tailwind v4 is configured from CSS, and the `@tailwindcss/vite` plugin reads `index.css` directly. `@theme inline` is what turns `--background` into `bg-background`, and the `inline` keyword is load-bearing — it makes the generated utility reference `var(--background)` rather than baking in a resolved value, which is what lets `.dark` re-point every utility at runtime with no second stylesheet.

| Token | Role |
| ----- | ---- |
| `--background` / `--foreground` | Page surface and body text |
| `--card` / `--card-foreground`, `--popover` / `--popover-foreground` | Panel and overlay surfaces |
| `--border`, `--input`, `--ring`, `--overlay` | Hairlines, field outlines, focus ring, dialog scrim |
| `--highlight`, `--shadow` | Elevation — consumed by the `shadow-raised` / `shadow-floating` utilities, not used directly |
| `--muted` / `--muted-foreground` | Secondary surfaces, metadata text |
| `--primary` | Primary actions |
| `--neutral` | Secondary buttons, inert badges |
| `--attention` | "Waits on you" — needs-decision/action/QA badges, the needs-you rail, the inbox count. Reserved for that |
| `--destructive` | Delete actions, error states, blocked |
| `--success`, `--warning`, `--info` | Status and priority badges |

Every semantic color comes as a **quartet**: `--x` (solid fill), `--x-foreground` (text on it), `--x-subtle` (tinted fill), `--x-subtle-foreground` (text on that). Badges use the subtle pair so status stays scannable across 60 rows without shouting; solid fills are reserved for actions.

## Color system

The palette follows a few well-established rules for long-session, glanceable tools (Material's dark theme guidance, Radix Colors' step roles, and the isolation/von Restorff effect):

- **Elevation is lightness.** In dark mode drop shadows barely read, so each layer up the stack is lighter: map well (≈0.24 L) → page `--background` (0.255) → `--card` (0.295) → `--muted`/hover (0.325) → `--popover` (0.33). Borders sit clearly above all of them (0.385) so panel edges are visible. Light mode inverts it: an off-white page (0.972) so white cards can sit on it.
- **Resting panels use `shadow-raised`, floating things use `shadow-floating`.** Both start with a 1px inset top `--highlight` — in dark mode that lit edge, not the drop shadow, is what makes a card look lifted. Don't put a card on a card; inside one, use `bg-muted`.
- **No pure black, no pure white.** The dark base is a lifted slate (~#262c36) and body text ~94% lightness. Maximum contrast on near-black halates and tires the eye; this still clears 4.5:1 everywhere.
- **One hue, one job.** Blue (`primary`) = something you can click. Amber (`attention`) = waits on *you*, nothing else — so the eye finds it pre-attentively. Red = blocked/destructive, green = done/working, yellow (`warning`) = high priority. A new use of amber or blue needs to mean the same thing.
- **Shape before colour where hues get close.** Status pills are filled, priority pills (below `urgent`) are outlined; the three needs-you kinds share amber and differ by icon. In dark mode, tinted fills of nearby hues all converge on brown.
- **Loudness follows importance.** Only stats that want a human colour their number ("waiting on you", "blocked" when non-zero); the rest keep a coloured edge only. Rarely-wanted actions like Delete are outlined, with the solid red saved for the confirm dialog.
- **Dark-mode accents are lighter and slightly desaturated** than their light twins, so they don't vibrate against the dark ground.
- **Map lanes (project colours) avoid amber and red**, because on the map those hues mean "waits on you" and "blocked".

- **The estuary carries past the map, in water hues only.** Every page sits on the map's contour paper (`.estuary-ground`, `--ground-contour`), and the header's bottom edge is a drifting waterline (`--waterline`, `--waterline-soft`). Page eyebrows speak the map's region voice (`ReachEyebrow`: "THE POOLS *where work waits on you*"), and all-clear empty states use `EmptyState art="still-water"`. Keep these decorative, faint, and out of cards: they frame the page and never compete with content. Motion is ambient and slow, and `prefers-reduced-motion` stops it.

**Color never carries meaning alone.** Every badge renders its text label; every error has text, not just a red border.

## Type and spacing

- Body 14px (`text-sm`), page title 24px (`text-2xl`), section headings 16px semibold. Metadata 12px in `muted-foreground`.
- Inputs are **16px on mobile** — anything smaller makes iOS Safari zoom on focus, which reads as a bug.
- Spacing uses the 4px scale; page gutters `px-4` mobile, `px-6` from `md`.
- One `max-w-6xl` container centered; forms cap at `max-w-2xl` (a 1200px-wide text input looks broken).

## Breakpoints

| Name | Width | What changes |
| ---- | ----- | ------------ |
| base | 360–639 | Single column, stacked cards, sticky form actions, bottom-sheet filters |
| `sm` | 640 | Buttons regain labels, actions sit side by side |
| `md` | 768 | **Table replaces cards**, filter bar goes inline, detail page gains its aside |
| `lg` | 1024 | Extra table column (project) |
| `xl` | 1280 | Container reaches max width |

`md` is the important one — it is where the list flips between two genuinely different components. Test at 360, 768, and 1280.

## Required states

Every data-driven view wires all four. A missing empty state is the single most common reason a submission reads as unfinished.

| State | Rule |
| ----- | ---- |
| Loading | Skeleton matching the real layout's shape and height — never a centered spinner that collapses the page |
| Empty | Explain and offer the next action. **Distinguish "nothing exists" from "nothing matches"** and offer "create" vs "clear filters" accordingly |
| Error | In-place panel with mapped copy and a Retry that calls `refetch()`. Never `window.location.reload()` |
| Success | Toast for mutations; navigation for create/edit. Never both a toast and a modal |

Refetch keeps previous data visible at reduced opacity with `aria-busy` — a table that blanks on every page change feels broken.

## Component patterns

- **Buttons:** one primary per view. Destructive actions use `destructive` and always confirm first.
- **Forms:** label above input, help text below, error replaces help text. Validate on blur, then on change once errored.
- **Dialogs:** Radix. Focus trapped, `Escape` closes, focus returns to the trigger, safe action focused by default.
- **Tables:** semantic `<table>` with `<caption class="sr-only">` and `aria-sort` on the active header. Never a grid of divs.
- **Row links:** a real `<a>` inside the row, not `onClick` on the `<tr>` — middle-click and "open in new tab" must work.
- **Dates:** relative in the UI ("2 days ago"), absolute in `title` and in `<time datetime>`.

## Accessibility baseline

Not exhaustive WCAG, but these are non-negotiable:

- Every interactive element reachable and operable by keyboard, with a visible `focus-visible` ring (never `outline: none` without a replacement).
- Every input has a real `<label for>`. Placeholders are not labels.
- Icon-only buttons carry `aria-label`; decorative icons are `aria-hidden`.
- Landmarks (`header` / `main` / `footer`) and a skip link.
- Errors linked via `aria-describedby` with `aria-invalid` on the field.
- Live regions: polite for result counts and status changes, assertive for form-error summaries.
- Body text meets 4.5:1 contrast; `muted-foreground` is checked against both surfaces it sits on.

## Dark mode

Tokens are defined under a `.dark` class and the app respects `prefers-color-scheme`. If a color is only defined in the light block, it will look wrong in dark — define both or neither.

The class is the single mechanism, and `prefers-color-scheme` feeds *into* it rather than sitting beside it as a second media query: `src/lib/theme.ts` resolves a three-state preference (`light` / `dark` / `system`, default `system`) and toggles `.dark` on `<html>`. "System" is stored explicitly rather than as the absence of a stored value, so "go back to matching my OS" stays reachable after a user has once chosen a theme. An inline script in `index.html` runs the same resolution before first paint, so a dark-mode user never sees a white flash; it is a deliberate duplicate of `theme.ts` and the two must be kept in step.

**The both-blocks rule is enforced, not trusted.** `apps/web/tests/design-tokens.test.ts` parses `index.css`, asserts `:root` and `.dark` declare identical key sets, fails on any empty value, and checks that `@theme inline` maps exactly the tokens that exist — no orphans in either direction. It lives in `tests/` rather than beside the CSS because it needs `node:fs`, and `apps/web` is deliberately browser-typed.

## Related

- [../pages/README.md](../pages/README.md) — per-screen layouts
- [../features/Task_Priority.md](../features/Task_Priority.md), [../features/Task_Status_Lifecycle.md](../features/Task_Status_Lifecycle.md) — badge mappings
