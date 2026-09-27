---
name: dumbpad-api
description: Manage DumbPad through its authenticated HTTP API. Use for frequent article, Thought, and Today Draft work; use the OpenAPI document when an operation is not covered here. Never edit DumbPad storage files directly.
---

# DumbPad API Agent

Use the authenticated HTTP API only. It preserves versions, live updates, search indexes, storage layout, and the daily lifecycle of Today Drafts. Do not write `data/`, browser storage, or S3 objects directly.

## Choose The Right Area First

| Area | Use it for | Agent writing guidance |
| --- | --- | --- |
| Article (Notepad) | Detailed records, context, source material, structured Markdown, or anything that needs to remain discoverable. | Write the full record here. Length is not constrained. |
| Thought | A persistent, concise idea, reminder, or task that may be retained and organized later. | Prefer one clear sentence, normally no more than 50 Chinese characters. If it needs explanation, create an Article instead. |
| Today Draft | An immediate, disposable action for today only. The server clears it when the next local calendar day begins. | Keep it to one short sentence, usually a few to a few dozen characters. Do not use it as a permanent inbox. |

Ask the user when the correct area is unclear. Do not silently shorten content; move detailed material to an Article.

## Connect And Discover

Use the app URL supplied by the user. For trusted automation, configure one credential; do not print, commit, or embed it in browser code.

```bash
export DUMBPAD_BASE_URL="http://localhost:10003"
export DUMBPAD_TOKEN="<user-provided PIN or scoped API token>"

curl -fsS "$DUMBPAD_BASE_URL/api/auth/status"
curl -fsS "$DUMBPAD_BASE_URL/api/meta"
curl -fsS "$DUMBPAD_BASE_URL/openapi.json"
```

Use `Authorization: Bearer $DUMBPAD_TOKEN` for protected routes. `mode: "legacy"` accepts the deployment PIN; Auth V2 requires a scoped API token. A read needs `content:read` or `thoughts:read`; a mutation needs `content:write` or `thoughts:write`.

`GET /openapi.json` is the complete machine-readable contract. Query its `paths` object to find an uncommon endpoint or its request/response schema; `api.md` is the expanded human reference in this repository. This Skill intentionally lists only frequent operations.

## Operating Rules

1. Read the current item before changing an existing Article, Thought, or Today Draft. Send its `baseVersion` for updates and deletes.
2. On `409`, fetch the latest object and merge only the requested change. Never retry a stale overwrite blindly.
3. Search before creating a permanent Article or Thought when duplication is plausible.
4. Treat `DELETE`, trash restoration, and data-management actions as destructive. Require explicit user confirmation before calling them.

## Frequent Operations

### Articles

Use an Article for detailed work. `Notepad` is its metadata; `Note` is its Markdown body.

```bash
# Find an existing article or create a detailed record.
curl -fsS "$DUMBPAD_BASE_URL/api/notepads?title=release" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN"

curl -fsS -X POST "$DUMBPAD_BASE_URL/api/notepads" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Release notes","content":"# Release notes\n"}'

# Read full note first, or fetch outline to target sections without downloading full body.
curl -fsS "$DUMBPAD_BASE_URL/api/notes/<article-id>" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN"

curl -fsS "$DUMBPAD_BASE_URL/api/notes/<article-id>/outline" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN"

# Narrow Markdown edit:
# NOTE on `replace_section`: replaces ONLY the body under that heading (server preserves the heading line).
# Do NOT include the heading line in `text`, otherwise the heading will be duplicated.
curl -fsS -X PATCH "$DUMBPAD_BASE_URL/api/notes/<article-id>" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"replace_section","section":"release-notes","text":"All checks green.\n","baseVersion":3,"userId":"agent"}'

# Atomic batch edits: multiple changes applied under one write lock and one version bump.
curl -fsS -X POST "$DUMBPAD_BASE_URL/api/notes/<article-id>/edits" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"baseVersion":4,"userId":"agent","edits":[{"action":"replace_section","section":"summary","text":"Updated summary.\n"},{"action":"append","text":"\n- Follow up item"}]}'
```

Prefer narrow `PATCH` actions for edits, or `POST /api/notes/:id/edits` when several dependent changes must be atomic; inspect `/openapi.json` for the full edit action list and exact schemas.

### Thoughts

Thoughts are persistent but deliberately concise. Search with `light=1` when selecting or deduplicating, then mutate one item with its current version.

```bash
curl -fsS "$DUMBPAD_BASE_URL/api/thoughts?q=release&light=1&limit=8" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN"

curl -fsS -X POST "$DUMBPAD_BASE_URL/api/thoughts" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"确认发布窗口","tags":["release"]}'

curl -fsS -X PATCH "$DUMBPAD_BASE_URL/api/thoughts/<thought-id>" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"toggle_complete","baseVersion":1}'
```

`PATCH /api/thoughts/:id` returns `{ "success": true, "thought": ... }`; use that returned Thought and version for the next operation.

### Attachments

Upload an image with `POST /api/assets/images` or a permitted ordinary file with `POST /api/assets/files`. The response contains `assetId`; byte-identical uploads reuse the existing asset instead of duplicating it.

```bash
# Upload an image. Use its real MIME type and filename.
curl -fsS -X POST "$DUMBPAD_BASE_URL/api/assets/images" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN" \
  -H "Content-Type: image/png" \
  -H "X-Asset-Name: screenshot.png" \
  --data-binary "@./screenshot.png"

# Upload an ordinary file.
curl -fsS -X POST "$DUMBPAD_BASE_URL/api/assets/files" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  -H "X-Asset-Name: brief.pdf" \
  -H "X-Asset-Type: application/pdf" \
  --data-binary "@./brief.pdf"
```

To attach an uploaded asset to a Thought, first read `GET /api/thoughts/:id`. Preserve its existing `attachments`, append `{ "assetId": "<asset-id>" }`, then send the complete array in `PATCH /api/thoughts/:id` with `action: "overwrite"` and the current `baseVersion`. The server validates the asset and fills in its file metadata and URLs.

```bash
curl -fsS -X PATCH "$DUMBPAD_BASE_URL/api/thoughts/<thought-id>" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"overwrite","attachments":[{"assetId":"<existing-asset-id>"},{"assetId":"<new-asset-id>"}],"baseVersion":3}'
```

### Today Drafts

Today Drafts are single, date-scoped rows. `GET /api/today-drafts` returns `{ day, items }` covering a 3-day window (today plus the two previous days); every row carries its own `day`. Do not attempt to retain rows older than the window. A caller supplies the row ID so offline clients can retry safely; a create may carry a `day` inside the window (offline drafts replayed after midnight land on their original day), while updates always keep the stored `day`.

```bash
# List today's rows.
curl -fsS "$DUMBPAD_BASE_URL/api/today-drafts" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN"

# Create one short row. Omit baseVersion only for a new ID.
curl -fsS -X PUT "$DUMBPAD_BASE_URL/api/today-drafts/today-standup-01" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"回复团队消息","completed":false}'

# Update one existing row with its current version.
curl -fsS -X PUT "$DUMBPAD_BASE_URL/api/today-drafts/today-standup-01" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"回复团队消息","completed":true,"baseVersion":1}'
```

To discard an individual Today Draft, first obtain explicit user confirmation, then call `DELETE /api/today-drafts/:id` with its current `baseVersion`. To retain a draft beyond today, create a concise Thought or detailed Article first, confirm it succeeded, then delete the draft.

### Search

Use the combined search only when the target area is unknown:

```bash
curl -fsS "$DUMBPAD_BASE_URL/api/search?q=release&scope=all&page=1&pageSize=20" \
  -H "Authorization: Bearer $DUMBPAD_TOKEN"
```

## Errors And Conflicts

- `400`: validate the request against `/openapi.json`; do not guess fields.
- `401` or `403`: stop and ask for a valid credential or the required scope.
- `404`: confirm the ID and, for Today Drafts, that it still belongs to the current server day.
- `409`: follow the merge rule above and retry once only after a safe merge.
