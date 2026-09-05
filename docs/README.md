# DumbPad Documentation

This index separates current project documentation from historical development notes.

For a new AI session, start with `../AGENTS.md` (the AI charter: commands, directory responsibilities, constraints, git workflow). It lives only on the local machine and is never committed.

## Root Docs

- `../README.md` - product overview, setup, environment variables, deployment, and common commands.
- `../ARCHITECTURE.md` - system panorama, module boundaries, core data flows, and known trade-offs.
- `../CHANGELOG.md` - version history and breaking changes (Keep a Changelog).
- `../AGENTS.md` - AI Agent charter. **Local only, never committed or pushed.**

## Current Docs

- `api.md` - current REST API reference, including Today Draft lifecycle and WebSocket events; `GET /openapi.json` is the complete machine-readable contract.
- `SKILL.md` - concise Agent guidance for choosing Articles, Thoughts, or Today Drafts and using their frequent operations.
- `technical-overview.md` - current architecture boundaries and module responsibilities (implementation-level detail).
- `sync-boundaries.md` - sync ownership for Notepad, Thought, AI, S3, WebSocket, and conflicts.
- `storage-interface.md` - storage boundary for local files and S3-compatible backends.
- `ai-pipeline-interface.md` - AI queue/provider contracts and relation write constraints.
- `ai-agent-framework.md` - interactive Agent workflow boundaries, staged rollout, and the implemented read-only `recall_context` baseline.
- `superpowers/specs/2026-07-16-data-safety-v1-design.md` - confirmed personal-security, backup, restore, and audit boundaries; read it before changing data-management code or deployment credentials.
- `cloudflare-deployment.md` - Cloudflare-oriented deployment notes.
- `markdown-syntax-highlighting.md` - supported syntax highlighting languages and examples.

## Archived Docs

`archive/` is kept **locally only** (excluded via `.git/info/exclude`) and should not be treated as current requirements.

- `archive/api-report-legacy-v1.3.md` - older API automation report. Historical; use `api.md` for current API behavior.
- `archive/2026-09-05-API_REPORT.md` - the same legacy v1.3 report that used to sit in the repo root. Historical; superseded by `api.md`.
- `archive/2026-09-05-AGENT_CONTEXT.md` - the pre-`AGENTS.md` AI session entry doc. Superseded by `../AGENTS.md`; kept for history.
- `archive/2026-09-05-MARKDOWN_SYNTAX_HIGHLIGHTING_USAGE.md` - duplicate of `markdown-syntax-highlighting.md`. Historical.
- `archive/2026-09-05-ui-ux-mobile-optimization-plan.md` - the 2026-06 UI/UX working plan, last updated 2026-06-02 and not refreshed by later UI work. Historical; not current requirements.
- `archive/audit-2026-07-06.md` - point-in-time safety/security audit. Historical.
- `archive/audit-sync-performance.md` - point-in-time sync/performance audit. Historical.
- `archive/FIX-SUMMARY-2026-07-06.md` - fix summary for the 2026-07-06 audit. Historical.
- `archive/FIX-SUMMARY-2026-07-27.md` - fix summary for the follow-up hardening round. Historical.

## Local Ignored Notes

The old `todo*.md`, `thought.md`, and private AI/provider notes were moved out of the root into ignored `.local/` folders. They were useful during development, but they are not current requirements and should not guide new implementation work.

## Tests

All regression tests live in `../test/` (`test/test_*.js`), not the repo root. Run them with:

- `npm test` - the full suite, 89 files (excludes `test_s3_real_smoke.js`, which needs a live S3 endpoint).
- `npm run test:<name>` - an individual test; scripts are declared in `../package.json`.
- `node test/test_<name>.js` - run a single file directly.

"Which test covers what I changed" is mapped in `../AGENTS.md`.

## Root Hygiene

The repository root holds only four markdown files: `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, and `AGENTS.md`. Everything else lives under `docs/`.

- `server.js` is the only JavaScript file in the application root.
- Regression tests live in `../test/`, not the root. They are current only when referenced by `package.json` scripts.
- Old one-off patch scripts and manual tests stay out of the root and should not be treated as current workflows.

## Maintenance Rules

- Keep root docs small and intentional: the four files listed above.
- Put durable technical docs in `docs/`.
- Put historical docs in `docs/archive/` with a `YYYY-MM-DD-` prefix and a historical header. Archived docs are local-only and are not pushed.
- Keep secrets, provider keys, scratch notes, and private planning files ignored and out of Git.
- When code changes invalidate a doc, update the doc in the same change.
