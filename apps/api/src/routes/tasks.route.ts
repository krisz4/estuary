import {
  createTicketInputSchema,
  hasAtLeastOneField,
  ticketListQuerySchema,
  updateTicketInputSchema,
} from "@helpdesk/contracts";
import { Router } from "express";

import { asyncHandler } from "../lib/asyncHandler.js";
import { atLeastOneField } from "../lib/errors.js";
import { parseTicketId } from "../lib/params.js";
import {
  createTicket,
  deleteTicket,
  getTicket,
  getTicketFacets,
  updateTicket,
} from "../services/ticket.service.js";
import { listTickets } from "../services/ticket-query.js";

/**
 * `/api/v1/tickets` — the HTTP layer for the ticket resource.
 *
 * Each handler does three things and nothing else: **parse, call a service,
 * send.** There is no Prisma import in this file and there cannot be one — the
 * layer rule in `docs/engineering/ARCHITECTURE.md` is what keeps the services
 * testable without a server, and `src/routes/layers.test.ts` asserts it
 * mechanically rather than trusting review.
 *
 * Responses are what the service returned. `services/ticket.service.ts` returns
 * **serialized contract types**, not Prisma rows, so no handler here can forget
 * `lib/serialize.ts` and leak a `Date` or a rank column onto the wire.
 *
 * Validation is `.parse()`, not `safeParse` + a hand-built response: a
 * `ZodError` reaching `errorHandler` becomes `VALIDATION_ERROR` 422 with
 * per-field `details` already. The one deliberate exception is the path
 * parameter — see `lib/params.ts`, where a parse failure becomes a 404.
 */

export const ticketsRouter: Router = Router();

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

/**
 * `GET /tickets` — filter, sort, page. The whole query surface is one schema
 * parse; `services/ticket-query.ts` receives a fully validated, defaulted object
 * and never sees a raw string.
 *
 * `.strict()` on that schema means an unknown param is a 422 rather than a
 * silently ignored filter, and `pageSize=101` is **rejected, not clamped** — a
 * client asking for 500 rows has a bug worth surfacing rather than papering over.
 */
ticketsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = ticketListQuerySchema.parse(req.query);
    res.status(200).json(await listTickets(query));
  }),
);

/**
 * `GET /tickets/facets` — **declared before `/:ticketId`, and the order is
 * load-bearing.** Express matches in declaration order, so with these two
 * swapped, `facets` is captured as `:ticketId`, fails the decimal-digits parse,
 * and comes back as a 404 `TICKET_NOT_FOUND` — a routing bug wearing a
 * not-found error's clothes, on the endpoint the list page calls to populate its
 * assignee filter. `layers.test.ts` pins the order; a route test proves the
 * behaviour.
 */
ticketsRouter.get(
  "/facets",
  asyncHandler(async (_req, res) => {
    res.status(200).json(await getTicketFacets());
  }),
);

/** `GET /tickets/:ticketId` — one ticket with its full comment thread. */
ticketsRouter.get(
  "/:ticketId",
  asyncHandler(async (req, res) => {
    const id = parseTicketId(req.params.ticketId);
    res.status(200).json(await getTicket(id));
  }),
);

/* ------------------------------------------------------------------ *
 * Write
 * ------------------------------------------------------------------ */

/**
 * `POST /tickets` — **201 with a `Location` header**, per the error contract's
 * status conventions.
 *
 * The header is built from `req.baseUrl` rather than a hard-coded `/api/v1`
 * string: the prefix is chosen by the mount in `app.ts`, and a second copy of it
 * here would point at the old path the day that mount moves.
 */
ticketsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createTicketInputSchema.parse(req.body);
    const ticket = await createTicket(input);

    res.status(201).location(`${req.baseUrl}/${ticket.id}`).json(ticket);
  }),
);

/**
 * `PATCH /tickets/:ticketId` — partial update. `PUT` is deliberately absent: the
 * UI only ever sends partial edits, and offering both invites two write paths
 * that drift.
 *
 * **`{}` is valid to zod and invalid to the API**, which is why the emptiness
 * check is here rather than a `.refine()` on the schema. A refinement would
 * collapse it into `VALIDATION_ERROR`; the contract gives an empty PATCH its own
 * code, `AT_LEAST_ONE_FIELD` (422), with no field details — there is no field to
 * point at. `hasAtLeastOneField()` is exported from contracts so the web form can
 * make the same call before it ever sends the request.
 *
 * Order matters: parse first, then check. A body of `{ title: "x" }` is a
 * `VALIDATION_ERROR` (too short), not `AT_LEAST_ONE_FIELD`.
 */
ticketsRouter.patch(
  "/:ticketId",
  asyncHandler(async (req, res) => {
    const id = parseTicketId(req.params.ticketId);
    const input = updateTicketInputSchema.parse(req.body);
    if (!hasAtLeastOneField(input)) throw atLeastOneField();

    res.status(200).json(await updateTicket(id, input));
  }),
);

/**
 * `DELETE /tickets/:ticketId` — hard delete, comments cascade at the database
 * level.
 *
 * **204 and no body.** A JSON body on a 204 is a protocol violation that some
 * clients choke on, so this is `res.status(204).end()`, never `.json(...)`.
 */
ticketsRouter.delete(
  "/:ticketId",
  asyncHandler(async (req, res) => {
    const id = parseTicketId(req.params.ticketId);
    await deleteTicket(id);
    res.status(204).end();
  }),
);
