# DumbPad Documentation

This index separates current project documentation from historical development notes. For a new AI session, start with `../AGENT_CONTEXT.md`, then use this file as the map.

## Current Docs

- `../README.md` - product overview, setup, environment variables, and common commands.
- `../api.md` - current REST API reference.
- `technical-overview.md` - current architecture boundaries and module responsibilities.
- `sync-boundaries.md` - sync ownership for Notepad, Thought, AI, S3, WebSocket, and conflicts.
- `storage-interface.md` - storage boundary for local files and S3-compatible backends.
- `ai-pipeline-interface.md` - AI queue/provider contracts and relation write constraints.
- `ai-agent-framework.md` - interactive Agent workflow boundaries, staged rollout, and the implemented read-only recall_context baseline.
- `superpowers/specs/2026-07-16-data-safety-v1-design.md` - confirmed personal-security, backup, restore, and audit boundaries; use it before changing data-management code or deployment credentials.
- `cloudflare-deployment.md` - Cloudflare-oriented deployment notes.
- `markdown-syntax-highlighting.md` - supported syntax highlighting languages and examples.

## Archived Docs

- `archive/api-report-legacy-v1.3.md` - older API automation report. Keep for historical reference only; use `../api.md` for current API behavior.

## Local Ignored Notes

The old `todo*.md`, `thought.md`, and private AI/provider notes were moved out of the root into ignored `.local/` folders. They were useful during development, but they are not current requirements and should not guide new implementation work.

## Root JS Hygiene

The root should stay small:

- `server.js` is the application entrypoint.
- `test_*.js` files are current only when they are referenced by `package.json` scripts.
- Old one-off patch scripts and manual tests should stay out of the root and should not be treated as current workflows.

## Maintenance Rules

- Keep root docs small and intentional: `README.md`, `api.md`, and `AGENT_CONTEXT.md`.
- Put durable technical docs in `docs/`.
- Put historical tracked docs in `docs/archive/` and clearly mark them as historical.
- Keep secrets, provider keys, scratch notes, and private planning files ignored and out of Git.
