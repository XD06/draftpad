# DumbPad Agent Context

This is the first file to read when starting a new AI coding session for this repo.

## Current Project State

DumbPad is a local-first Markdown draft app with Quick Thoughts, AI-assisted Thought relations, S3-compatible storage, WebSocket sync, and PWA/mobile support.

The current branch is the refactored application line. Treat the codebase as the source of truth and treat archived development notes as historical context only.

## Read Order

1. `README.md` - product overview, setup, environment variables, and verification commands.
2. `docs/README.md` - documentation map and which docs are current vs archived.
3. `docs/technical-overview.md` - current architecture boundaries after refactoring.
4. `api.md` - current REST API reference.
5. Boundary docs as needed:
   - `docs/sync-boundaries.md`
   - `docs/storage-interface.md`
   - `docs/ai-pipeline-interface.md`

## Current Architecture

- `server.js` is the Node/Express entrypoint and route registration hub.
- `routes/*.js` contains HTTP route modules for auth, notes, notepads, search, sharing, static assets, thoughts, and data management.
- `server/websocket.js` owns WebSocket connection handling and sync broadcasts.
- `server/indexing.js` owns shared search/indexing helpers.
- `scripts/storage.js` is the user-data storage boundary for local JSON/txt and S3-compatible storage.
- `scripts/ai-provider.js` encapsulates AI provider calls and falls back to noop behavior when AI config is absent.
- `scripts/ai-queue.js` owns background Thought AI analysis, relation generation, and status broadcasts.
- Frontend code lives mainly under `public/`; large Thought behavior has been split into focused modules, including `public/managers/thought-tags.js` for tag normalization, persistence, tag-filter/Quick Add tag HTML helpers, and AI suggested tag HTML, `public/managers/thought-ai-status.js` for AI status normalization, pending-delay calculation, socket detail application, labels/icons/detail HTML, `public/managers/thought-card-renderer.js` for pure Thought card HTML rendering, `public/managers/thought-relations-panel.js` for relation panel and manual relation option HTML, `public/managers/thought-relations-state.js` for local relation count/pending state transitions, `public/managers/thought-editor.js` for legacy subtask parsing, editable parts, subtask cleanup/sorting, edit-row HTML, and local subtask mutations, `public/managers/thought-quick-add.js` for Quick Add local pending/create outbox data construction, and `public/managers/thought-text-formatting.js` for HTML escaping, linkify, and regex escaping.

## Root JavaScript Files

Root-level JavaScript files are intentionally limited:

- `server.js` - application entrypoint.
- `test_*.js` - current regression tests when referenced by `package.json` scripts.

Historical one-off patch scripts, old manual Thought API tests, and unused reference constants have been moved out of the root into local/scratch legacy folders. Do not treat those legacy files as current workflows.

Current test scripts are declared in `package.json`. Prefer running tests through npm scripts instead of invoking root test files by memory.

## Important Constraints

- Do not change user-facing behavior while refactoring unless the user explicitly asks for a feature or bug fix.
- Do not touch icon/image assets unless the user explicitly asks; the user may have manually edited them.
- Keep S3 and local storage behavior behind `scripts/storage.js`.
- Keep AI-generated relations separate from user-confirmed/manual relations.
- Preserve multi-device version conflict handling for notes.
- Preserve PWA/mobile performance work: service worker caching, cached app shell, lazy Thought rendering, and mobile layout behavior.
- For PWA caching, keep unversioned JS/CSS/JSON on a network-first-with-cache-fallback path. Do not switch them back to pure cache-first unless asset URLs are content-hashed; normal reloads must not keep serving stale styles or modules.

## Data Safety Fixes (2026-06)

Four critical data-safety bugs were fixed:

1. **Thought CRUD race condition** — `storage.js` now exposes `withThoughtWriteLock()`, an async mutex that serializes read-modify-write operations. `thought-routes.js` POST/PATCH/DELETE handlers wrap their entire read-modify-write cycle in this lock to prevent concurrent requests from overwriting each other's changes.
2. **Note save bypassing storage layer** — `note-routes.js` POST `/api/notes/:id` previously used `fs.writeFile` directly when a notepad was not in meta, which silently lost data in S3 mode. It now routes through `storage.writeNoteContent()` with a fallback notepad object.
3. **Note content non-atomic write** — `storage.js` `writeNoteContent()` now uses temp-file + rename for local writes, matching the atomic write pattern already used by `writeJSON()`. This prevents file corruption on crash during write.
4. **PATCH Note null pointer crash** — `note-routes.js` PATCH `/api/notes/:id` used `targetNotepad.version` without a null check. If the notepad was deleted between the initial lookup and the second `readNotepadsMeta()` call, the route would throw `TypeError`. Now uses `targetNotepad?.version || 1`.

## Verification Commands

Use focused checks for the area touched:

```bash
npm run check
npm run test:api
npm run test:thought-modules
npm run test:note-sync
npm run test:pwa-cache
npm run test:ai-queue
npm run test:s3-storage
npm run test:s3-prefix
```

Do not run `npm run test:s3-real` unless real S3 environment variables are configured and the user wants a real cloud smoke test.

Useful test mapping:

- `npm run test:api` - current API regression coverage.
- `npm run test:thought-modules` - aggregate Thought frontend helper checks; run after changing split Thought modules or `ThoughtsManager` helper delegation.
- `npm run test:note-sync` - note version and multi-client sync behavior.
- `npm run test:pwa-cache` - PWA cache regression checks.
- `npm run test:thought-card-renderer` - pure Thought card HTML rendering checks, including legacy checkbox parsing, relation count badge classes, and collapsed subtask summaries.
- `npm run test:thought-editor` - Thought editor helper checks, including legacy checkbox parsing, editable subtask cloning, edit-row escaping, cleanup, sorting, and local subtask mutations.
- `npm run test:thought-quick-add` - Quick Add data construction checks, including created pending AI state, local pending fallback thoughts, cloned tags, and create outbox payloads.
- `npm run test:thought-relations-panel` - pure Thought relation panel rendering checks, including manual relation summaries, escaping, highlighting, and empty results.
- `npm run test:thought-relations-state` - local Thought relation state checks, including relation count normalization and manual relation create/delete success/failure transitions.
- `npm run test:thought-text-formatting` - pure Thought text formatting checks, including escaping, regex escaping, and existing linkify punctuation behavior.
- `npm run test:ai-queue` - AI queue and relation generation behavior.
- `npm run test:relations` - relation scoring/calculation helpers.
- `npm run test:s3-storage` and `npm run test:s3-prefix` - mocked/local S3 boundary checks.

## Documentation Hygiene

- Current docs are linked from `docs/README.md`.
- `docs/archive/` contains historical documents. Do not treat archived documents as current requirements.
- Local private planning files and provider notes are kept under ignored `.local/` paths and should not be committed.
- If a doc becomes outdated after code changes, update it in the same change.
- Treat documentation, tests, and durable project records as part of task completion, not optional follow-up. After each refactor or optimization slice, update the relevant docs/tests/context records so future agents and maintainers are not misled by stale boundaries or missing verification notes.
