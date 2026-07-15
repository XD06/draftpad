---
name: dumbpad-api
description: Manage the current DumbPad app through its authenticated HTTP API. Use when an agent needs to create, read, edit, search, pin, organize, or delete DumbPad Notepads or Thoughts. Also use for optimistic-concurrency handling, Thought pagination, manual relations, and trash recovery. Do not use for direct edits to the data directory or for S3/data-management destructive operations without explicit user confirmation.
---

# DumbPad API Agent

Operate DumbPad only through its HTTP API. The API keeps Notepad versions, search indexes, storage layout, trash records, and live updates coherent; direct edits to `data/`, `localStorage`, or S3 objects bypass those guarantees.

## Configure The Session

Use the app URL supplied by the user. For trusted local automation, set these variables before making requests:

```bash
export DUMBPAD_BASE_URL="http://localhost:10003"
export DUMBPAD_PIN="<user-provided-pin>"
```

Use the PIN only in the Authorization header. Never print it, embed it in a browser client, commit it, or infer it from `.env`.

```bash
curl -fsS "$DUMBPAD_BASE_URL/health"
curl -fsS "$DUMBPAD_BASE_URL/api/pin-required"
curl -fsS "$DUMBPAD_BASE_URL/api/notepads" \
  -H "Authorization: Bearer $DUMBPAD_PIN"
```

`/health` does not require authentication. Except for `/api/verify-pin`, `/api/pin-required`, and `/api/config`, API routes require the `dumbpad_auth` cookie or `Authorization: Bearer <PIN>`.

## Operating Rules

1. Read an item's current version before changing it. Send that value as `baseVersion` on every Notepad, Note, and Thought mutation.
2. On `409`, fetch the latest server state, compare it with the intended change, and merge narrowly. Do not retry an overwrite with stale content.
3. Use a stable, descriptive ID when an integration creates a Notepad. Valid caller-provided IDs contain only letters, digits, `_`, and `-`, and are 3-96 characters long.
4. Treat `DELETE` and all data-management endpoints as destructive. Ask for confirmation before deleting content, emptying trash, restoring over a conflicting item, or operating on S3/local overwrite routes.
5. Prefer `light=1` for Thought picker/search workflows. It avoids unnecessary AI metadata and relation reads.

## Notepads And Markdown

Notepad is metadata; Note is its Markdown body.

### List And Create

Use `GET /api/notepads` to list metadata. Use `POST /api/notepads` to create a Notepad and its initial Markdown body.

```bash
# List newest articles
curl -fsS "$DUMBPAD_BASE_URL/api/notepads?sortBy=updatedAt&order=desc" \
  -H "Authorization: Bearer $DUMBPAD_PIN"

# Create an article and its initial Markdown body
curl -fsS -X POST "$DUMBPAD_BASE_URL/api/notepads" \
  -H "Authorization: Bearer $DUMBPAD_PIN" \
  -H "Content-Type: application/json" \
  -d '{"id":"agent-release-notes","name":"Release notes","content":"# Release notes\n"}'
```

`POST /api/notepads` accepts `name` and `content`; `id` is optional. The response contains `id`, `name`, `version`, `createdAt`, and `updatedAt`.

### Read And Save A Note

Use `GET /api/notes/:id` to read Markdown and its version. Use `POST /api/notes/:id` to save a complete replacement, or `PATCH /api/notes/:id` for a narrow edit.

```bash
# Read Markdown and its current version
curl -fsS "$DUMBPAD_BASE_URL/api/notes/agent-release-notes" \
  -H "Authorization: Bearer $DUMBPAD_PIN"

# Replace the whole Markdown body using the version returned above
curl -fsS -X POST "$DUMBPAD_BASE_URL/api/notes/agent-release-notes" \
  -H "Authorization: Bearer $DUMBPAD_PIN" \
  -H "Content-Type: application/json" \
  -d '{"content":"# Release notes\n\nUpdated by an agent.","baseVersion":1,"userId":"agent"}'
```

Use `PATCH /api/notes/:id` for narrow edits:

| `action` | Required fields | Effect |
| --- | --- | --- |
| `append` | `text` | Append Markdown |
| `prepend` | `text` | Prepend Markdown |
| `replace` | `target`, `replacement` | Replace every occurrence |
| `replace_first` | `target`, `replacement` | Replace the first occurrence only |
| `overwrite` | `text` | Replace the entire body |

Always include `baseVersion` and a stable `userId`. A successful save returns the next `version`; use it for the next mutation.

### Rename And Pin

Use `PUT /api/notepads/:id` to rename. Use `PATCH /api/notepads/:id` to set a Notepad's pin state.

```bash
# Rename
curl -fsS -X PUT "$DUMBPAD_BASE_URL/api/notepads/agent-release-notes" \
  -H "Authorization: Bearer $DUMBPAD_PIN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Agent release notes","baseVersion":2}'

# Pin or unpin. Pinning records pinnedAt and puts the article first in the directory.
curl -fsS -X PATCH "$DUMBPAD_BASE_URL/api/notepads/agent-release-notes" \
  -H "Authorization: Bearer $DUMBPAD_PIN" \
  -H "Content-Type: application/json" \
  -d '{"pinned":true,"baseVersion":3}'
```

Do not delete a Notepad until the user has explicitly confirmed it. `DELETE /api/notepads/:id` moves it to trash; `default` cannot be deleted.

## Thoughts

A Thought is a task with optional `subItems`, `tags`, `attachments`, `pinned`, `completed`, and `version` fields.

### Query Efficiently

Use `GET /api/thoughts` for Thought listings and `GET /api/thoughts/:id` when a single current version is needed.

```bash
# Search current Thoughts without loading AI metadata
curl -fsS "$DUMBPAD_BASE_URL/api/thoughts?q=release&light=1&limit=8" \
  -H "Authorization: Bearer $DUMBPAD_PIN"

# Incremental, cursor-paginated sync
curl -fsS "$DUMBPAD_BASE_URL/api/thoughts?format=page&light=1&limit=50&updatedSince=0" \
  -H "Authorization: Bearer $DUMBPAD_PIN"
```

`GET /api/thoughts` supports `q`, `date` (`YYYY-MM-DD`), `tag`, `limit` (maximum 50), `light=1`, `format=page`, `cursor`, and `updatedSince` (Unix milliseconds). In page mode, continue only while `hasMore` is true and pass `nextCursor` to the next request.

### Create And Mutate

Use `POST /api/thoughts` to create a Thought. Use `PATCH /api/thoughts/:id` for all Thought changes.

```bash
curl -fsS -X POST "$DUMBPAD_BASE_URL/api/thoughts" \
  -H "Authorization: Bearer $DUMBPAD_PIN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Review the release","tags":["release"],"subItems":[{"id":"check-api","text":"Run API checks","completed":false}]}'

# Complete a Thought after reading its current version
curl -fsS -X PATCH "$DUMBPAD_BASE_URL/api/thoughts/<thought-id>" \
  -H "Authorization: Bearer $DUMBPAD_PIN" \
  -H "Content-Type: application/json" \
  -d '{"action":"toggle_complete","baseVersion":1}'
```

Supported Thought mutation actions:

| `action` | Fields |
| --- | --- |
| `toggle_complete` | none |
| `toggle_pin` | none |
| `overwrite` | one or more of `text`, `subItems`, `tags`, `completed`, `pinned`, `attachments` |
| `add_subitem` | `text` |
| `update_subitem` | `subId` and one or both of `text`, `completed` |
| `delete_subitem` | `subId` |
| `toggle_subitem` | `subId` |
| `append` | `text` |
| `replace` | `target`, `replacement` |

Every Thought `PATCH` should contain the current `baseVersion`. Read a single item with `GET /api/thoughts/:id` before a mutation when the current version is not already known.

## Search, Relations, And AI

Use `GET /api/search` for full-text Notepad search.

```bash
# Full-text Notepad search
curl -fsS "$DUMBPAD_BASE_URL/api/search?q=release&page=1&pageSize=20" \
  -H "Authorization: Bearer $DUMBPAD_PIN"

# Add a user-approved manual Thought relation
curl -fsS -X POST "$DUMBPAD_BASE_URL/api/thoughts/<source-id>/relations" \
  -H "Authorization: Bearer $DUMBPAD_PIN" \
  -H "Content-Type: application/json" \
  -d '{"targetId":"<target-id>","relationType":"related_context"}'
```

Read relations with `GET /api/thoughts/:id/relations`. Valid relation types include `supports`, `contradicts`, `step_sequence`, `same_topic`, `example_of`, `alternative`, and `related_context`.

AI processing is optional and asynchronous. Only call `POST /api/thoughts/:id/ai-process`, `POST /api/thoughts/:id/ai-insight`, `POST /api/thoughts/ai-backfill`, or `POST /api/thoughts/relations-rebuild` when the user asks for AI work. A `503` for insight normally means its dedicated model is not configured; do not substitute another model or modify the Thought body.

## Trash And Safety

Use `GET /api/trash` and `GET /api/trash/:trashId` to inspect deleted items. With explicit user confirmation only:

- `POST /api/trash/:trashId/restore` restores a trashed article or Thought.
- `DELETE /api/trash/:trashId` permanently removes one item.
- `DELETE /api/trash` empties the entire trash.

Do not call data-space, S3 backup, S3 delete, import, or local/cloud overwrite endpoints unless the user explicitly names the target data space and confirms the destructive action. For the full, machine-readable contract read `public/openapi.json`; for expanded human documentation read `api.md`.

## Conflict Procedure

When a mutation returns `409` with `currentVersion`:

1. Fetch the latest Notepad/Note or Thought.
2. Preserve remote changes and apply only the requested local intent.
3. Present a conflict for user input when both sides changed the same Markdown or Thought field.
4. Retry once with the new `baseVersion` only after a safe merge.

Never resolve a conflict by blindly overwriting remote content.
