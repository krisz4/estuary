# UI design guidelines

The brief asks for "decent" and "responsive on a mobile phone". That is the bar: a calm, dense, obviously-functional tool, correct at 360px. Not a design showcase.

## Stack

Tailwind CSS + a small set of local primitives in `src/components/ui/` (Button, Input, Textarea, Select, Badge, Dialog, Skeleton), Radix for dialog/select behavior, Sonner for toasts, `lucide-react` for icons.

No component library theme to fight, and no bespoke design system to maintain.

## Tokens

Defined as CSS variables in `src/index.css` and mapped in `tailwind.config.ts`. Use the token, never a raw hex.

| Token | Role |
| ----- | ---- |
| `--background` / `--foreground` | Page surface and body text |
| `--card` / `--border` | Panel surface, hairlines |
| `--muted` / `--muted-foreground` | Secondary surfaces, metadata text |
| `--primary` | Primary actions, focus ring |
| `--destructive` | Delete actions, error states |
| `--success`, `--warning`, `--info` | Status and priority badges |

Neutral base, one accent. Status color is the only strong color on the list screen — that is what makes 60 rows scannable.

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
| `lg` | 1024 | Extra table columns (assignee) |
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

## Related

- [../pages/README.md](../pages/README.md) — per-screen layouts
- [../features/Ticket_Priority.md](../features/Ticket_Priority.md), [../features/Ticket_Status_Lifecycle.md](../features/Ticket_Status_Lifecycle.md) — badge mappings
