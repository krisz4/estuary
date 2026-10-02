## What and why

<!-- What does this change, and why? Link the issue: "Closes #123". -->

## How it was verified

<!-- The commands you ran and what you checked by hand. For UI changes, add screenshots at 360px and desktop width. -->

## Checklist

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test` pass (and `pnpm test:e2e` if the UI or a workflow changed)
- [ ] API shape changed: the zod schema in `packages/contracts` changed first, and `apps/api/openapi.json` is regenerated
- [ ] `schema.prisma` changed: the migration is included, and no existing migration was edited
- [ ] Behavior, a route, a query param, or an env var changed: the matching doc in `docs/` (and `env.example`) is updated
- [ ] UI changed: checked at 360px, with loading, error, and empty states
- [ ] User-visible change: added under `Unreleased` in `CHANGELOG.md`
