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

`:ticketId` is parsed with `z.coerce.number().int().positive()`. A non-numeric path segment (`/tickets/abc`) fails that parse and returns **404 `TICKET_NOT_FOUND`**, not 422 — a malformed id and a missing ticket are indistinguishable to a caller, and treating them differently just tells a prober which ids are well-formed.

## Related pages

- [../pages/Tickets_List.md](../pages/Tickets_List.md)
- [../pages/Ticket_Detail.md](../pages/Ticket_Detail.md)
- [../engineering/DATABASE.md](../engineering/DATABASE.md)
