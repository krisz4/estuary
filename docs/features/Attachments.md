---
type: Feature
title: Attachments
description: File attachments on tickets — scoped out of the challenge; recorded so the decision is not re-litigated.
tags: [tickets, attachments, out-of-scope]
status: plan
---
# Attachments

**Not implemented. Do not build this without being asked.**

Screenshots are the most common real-world attachment on a helpdesk ticket, and the omission is noticeable — so this doc records the decision rather than leaving it looking overlooked.

## Why it is out of scope

The brief lists the ticket fields explicitly (`ticket number, title, description, user, status, comments`) and does not mention files. Adding uploads pulls in storage config, MIME/size validation, a static file route or object store, and a virus-scanning question — all outside what the challenge is assessing, and all of it makes the Docker setup heavier for a reviewer running it once.

## If it were built

Sketch only, unvalidated:

- `Attachment` model: `id`, `ticketId` (cascade), `filename`, `mimeType`, `sizeBytes`, `storageKey`, `createdAt`.
- `POST /api/v1/tickets/:ticketId/attachments` — multipart, single file, 10MB cap, allowlist of image + pdf MIME types validated by magic bytes, not by the client-supplied `Content-Type`.
- Local disk under a Docker volume for dev; S3-compatible storage behind an interface for anything real.
- `GET /api/v1/attachments/:id` streaming with `Content-Disposition: attachment` — never inline HTML/SVG, which is a stored-XSS vector.
- UI: dropzone on the create/edit forms, thumbnail strip on the detail page.

## Related

- [Tickets.md](./Tickets.md)
