---
type: Feature
title: Ticket numbering
description: The integer primary key doubles as the ticket number, displayed as HD-000042.
resource: packages/contracts/src/reference.ts
tags: [tickets, identity]
status: canonical
---
# Ticket numbering

The brief asks for a "unique ticket number". **The ticket's primary key is that number.** There is one identifier, not two.

| | |
| -- | -- |
| Column | `Ticket.id Int @id @default(autoincrement())` |
| In URLs and API paths | `/tickets/42`, `GET /api/v1/tickets/42` |
| Displayed as | `reference` = `HD-000042` |

## Why not a cuid id plus a separate number

That was the original design, and it does not compile. Prisma's SQLite connector only allows `@default(autoincrement())` on the `@id` field; on any other field it fails schema validation with *"The `autoincrement()` default value is used on a non-id field even though the datasource does not support this"* ([prisma#1938](https://github.com/prisma/prisma/issues/1938), [prisma#6477](https://github.com/prisma/prisma/issues/6477)). It works on PostgreSQL and MySQL, which is why the pattern looks familiar.

The alternatives, and why they lost:

| Option | Verdict |
| ------ | ------- |
| Cuid `id` + counter row incremented in a transaction | Works, but adds a table, a hot row, and a second write to every create — for a cosmetic field |
| Cuid `id` + `MAX(id) + 1` | Races under concurrent creates |
| **Int `id` used as the number** | One identifier, zero machinery, and it is exactly what the brief asked for |

The usual objection to sequential ids in URLs is enumeration. This app has **no authentication and no per-user data** — every ticket is readable by everyone by design — so there is nothing enumeration could reveal that the list endpoint does not already hand out. If auth is ever added, this is the decision to revisit first.

## Properties

- **Monotonic but not gapless.** A failed insert or a deleted ticket leaves a hole. That is expected and must not be "fixed" — closing gaps means renumbering, which invalidates every reference anyone wrote down.
- **Assigned by SQLite**, not by application code. No counter to keep in sync.
- **Stable.** The id never changes, so `HD-000042` always means the same ticket for as long as it exists.

## Formatting

`reference` is computed at serialization time, never stored:

```ts
export const formatReference = (id: number) => `HD-${String(id).padStart(6, "0")}`;
```

It lives in `packages/contracts/src/reference.ts` so the API and the web app format identically. Ids past 999999 simply render wider — the padding is a minimum, not a truncation.

## Parsing (search)

`parseReference()` in the same module accepts `HD-42`, `hd-000042`, `#42`, and a bare `42`, returning the integer or `null`. The list `q` filter uses it so pasting any of those forms into search matches that ticket — see [Ticket_Query_Filter_Sort_Page.md](./Ticket_Query_Filter_Sort_Page.md).

It matches the **whole** number, not a prefix: `q=HD-4` finds ticket 4, not tickets 40–49. Prefix matching on an integer column would mean a `CAST` and a full scan.

## Route parameter validation

`:ticketId` is parsed by `ticketIdParamSchema` in `packages/contracts/src/ticket.ts`, and `:commentId` by `commentIdParamSchema` beside it. A non-numeric path segment (`/tickets/abc`) fails that parse and returns **404 `TICKET_NOT_FOUND`**, not 422 — a malformed id and a missing ticket are indistinguishable to a caller, and treating them differently just tells a prober which ids are well-formed. `apps/api/src/lib/params.ts` is where the parse failure is turned into that 404, and it is the only place in the API where a zod failure is deliberately not a 422.

**Both schemas are `z.string().regex(/^\d{1,15}$/)` piped into `z.number().int().positive()` — decimal digits only, bounded, and not `z.coerce.number()`.** Coercion accepts `"0x2a"`, `"1e3"`, and `" 12 "`, which would serve ticket 42 under three alias URLs, and it would disagree with `parseReference()`: `?q=1e3` and `/tickets/1e3` would resolve differently.

**The `{1,15}` bound is the half that was missing and had to be measured.** With a bare `\d+`, `/tickets/0000000000000000042` returned ticket 42 while `?q=0000000000000000042` matched nothing — the two parsers disagreeing exactly as this section says they must not, because `parseReference` caps its digit run at 15 and the schemas did not. All three now take that bound from a single exported `TICKET_ID_MAX_DIGITS` in `packages/contracts/src/reference.ts` (15 is the widest run of digits that always fits inside `Number.MAX_SAFE_INTEGER`). It lives in `reference.ts` because `ticket.ts` imports `comment.ts`, so neither of those can share a constant with the other without closing an import cycle.

Two things this deliberately does **not** claim:

- **Leading zeros still alias.** `/tickets/042` is ticket 42. That is fine — what matters is that `?q=042` resolves to ticket 42 as well. The goal is agreement between the parsers, not a single canonical spelling.
- **Whitespace is the one place they diverge, on purpose.** `parseReference(" 12 ")` is 12, because a user pastes a search term with stray spaces and means the number inside it; `/tickets/%2012%20` is a 404, because a path segment carries no such intent and accepting it would add an alias for nothing. The param schemas are the stricter of the two, and only in that direction.

`packages/contracts/src/comment.test.ts` compares **all three** parsers over one shared input table — including `0000000000000000042`, `042`, `1e3`, `0x2a`, `" 12 "`, and the empty string — and asserts the shared digit cap. The earlier version of that test compared the two param schemas only to each other, which is why it passed while both disagreed with the third. A route test additionally asserts `/tickets/0x2a` and `/tickets/1e3` are 404s while `/tickets/42` is a 200.

## Related pages

- [../pages/Tickets_List.md](../pages/Tickets_List.md)
- [../pages/Ticket_Detail.md](../pages/Ticket_Detail.md)
- [../engineering/DATABASE.md](../engineering/DATABASE.md)
