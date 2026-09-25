---
type: Feature
title: Attachments
description: File attachments on tasks — scoped out of the challenge; recorded so the decision is not re-litigated.
tags: [tasks, attachments, out-of-scope]
status: plan
---
# Attachments

**Not implemented. Do not build this without being asked.**

Screenshots and log dumps are the most common real-world attachment on a task, and the omission is noticeable — so this doc records the decision rather than leaving it looking overlooked.

## Why it is out of scope

The original brief lists the task fields explicitly (`task number, title, description, user, status, comments`) and does not mention files, and nothing in the task-manager pivot (`links` on a task, `needs_qa` payloads) has required binary storage since — a PR/branch/doc URL in `links` covers what an agent needs to point at. Adding uploads pulls in storage config, MIME/size validation, a static file route or object store, and a virus-scanning question — all real cost for a need that has not shown up yet, and all of it makes the Docker setup heavier for a reviewer running it once.

## If it were built

Sketch only, unvalidated:

- `Attachment` model: `id`, `taskId` (cascade), `filename`, `mimeType`, `sizeBytes`, `storageKey`, `createdAt`.
- `POST /api/v1/tasks/:taskId/attachments` — multipart, single file, 10MB cap, allowlist of image + pdf MIME types validated by magic bytes, not by the client-supplied `Content-Type`.
- Local disk under a Docker volume for dev; S3-compatible storage behind an interface for anything real.
- `GET /api/v1/attachments/:id` streaming with `Content-Disposition: attachment` — never inline HTML/SVG, which is a stored-XSS vector.
- UI: dropzone on the create/edit forms, thumbnail strip on the detail page.

## Related

- [Tasks.md](./Tasks.md)
