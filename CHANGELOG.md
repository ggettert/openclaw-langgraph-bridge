# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(currently pre-1.0; minor versions may include breaking changes).

## [Unreleased]

### Added
- CONTRIBUTING.md, CODE_OF_CONDUCT.md (PR #47)
- CHANGELOG.md (this file)
- `docs/workflow-contract.md` — canonical workflow integration guide for OSS users (PR #47)
- README badges: npm version, CI status, license (PR #47)

### Changed
- `decision_only` parameter now functions per its name. When `true` (default), milestone events update flow state silently but do **not** wake the agent. When `false`, milestone events also wake the agent. Decision, HITL, and terminal events always wake the agent regardless of this setting. (#6, PR #47)
- README Status section updated to stable pre-1.0 framing; links to CHANGELOG.md for migration notes (PR #47)
- `docs/installation.md` rewritten for OSS users: generic prereqs, four install paths, full config reference, troubleshooting (PR #47)
- CONTRIBUTING.md trimmed and reorganized; Releases section added (PR #47)
- CONTRIBUTING.md "Where to File Things" — security row now points directly to GitHub Security Advisories (PR #47)

### Removed
- `LanggraphClient.resumeRun()` — dead code with wrong wire format. Use `dispatchAndStream` for resume operations. (#8, PR #47)
- `SECURITY.md` — security disclosure is via GitHub Security Advisories (see README Security section and CONTRIBUTING.md). (PR #47)

### Fixed
- Orphaned `queued` flow on dispatch failure now tombstoned so `langgraph_inspect` doesn't surface stale records. (#7, PR #47)
- `typebox` package replaced with canonical `@sinclair/typebox`. (#15, PR #47)
- Release tarball no longer ships devDependencies; `npm ci --omit=dev --omit=optional --omit=peer` + verification step in release workflow. (#23, PR #47)

---

## [0.12.4] - 2026-06-18

### Added
- Proactive wake-event posting (#41): the skill now defaults to one short thread post on every wake event. Format: `<emoji> <phase> <event-action> — <summary>`.
- Phase event contract standardized (#42): `docs/phase-event-contract.md` documents the `{phase, event, ticket_id, summary, ...}` shape workflows emit via `get_stream_writer()`.
- New `src/phase-event.ts` exports `PhaseEventPayload` type and `isPhaseEventPayload` runtime validator.
- `summaryMaxChars` plugin config key (default 4000) — single source of truth for summary truncation length.

### Changed
- Event classifier prefers explicit `summary` field over `summarizeFleetData` heuristic fallback. Legacy payloads without `summary` still work.
- Summary truncation is now owned by `processEvent` via `summaryMaxChars`. Hardcoded 500-char references removed.

---

## [0.12.3] - 2026-06-18

### Fixed
- Out-of-order wake delivery: multiple wake events arriving in tight succession now use a per-`sessionKey` FIFO queue (`src/wake-queue.ts`). The queue worker awaits each `wakeAgentAsync` call before pulling the next job. Different session keys have independent queues.
- Truncated milestone payloads: `.slice(0, 280)` replaced with configurable `summaryMaxChars` (default 4000). Truncation cuts at the last ASCII space with a ` …[truncated]` suffix.

### Added
- `src/wake-queue.ts` — per-session FIFO wake delivery queue.
- `src/text-utils.ts` — shared truncation helpers for SSE and webhook paths.
- `summaryMaxChars` plugin config key.

### Changed
- Sync `wakeAgent` replaced by `wakeAgentAsync` returning `Promise<void>`.

---

## [0.12.2] - 2026-06-17

### Fixed
- `contracts.tools` in plugin manifest was missing the v0.12.0 tools (`langgraph_list_workflows`, `langgraph_inspect_workflow`). Added `callbackPublicBaseUrl` to the manifest config declaration.

---

## [0.12.1] - 2026-06-17

### Fixed
- Skill (`skills/langgraph-bridge/SKILL.md`) was missing the full v0.12.0 tool list, banner, and description. Also added the `list_workflows` section to the skill.

---

## [0.12.0] - 2026-06-17

### Added
- `langgraph_inspect_workflow` tool: read a workflow's input schema before dispatching to validate input shape (#18).
- `langgraph_list_workflows` tool: discover all workflows on the configured LangGraph server, with `allowed: true/false` per any configured allowlist (#20).
- `allowedWorkflows` config key hardening extended to all three workflow tools (#20).
- Skill updated with introspect-before-dispatch pattern (#19).

---

## [0.11.2] - 2026-06-17

### Fixed
- Skill: cherry-picked `spec_path` branch requirement and post-resume replay guard from the Carpe fork.
- Release tarball now bundles runtime deps via `npm ci --omit=dev` (#14 — tarball was missing `node_modules`, causing silent plugin load failure on install).
- Terminated-flow guard: `processEvent` now ignores all event kinds for flows that have reached `graph:end` (#10, #16 — prevents SSE + webhook double-terminal from causing LangGraph retry storms or flipping flow status back to `waiting`).

---

## [0.11.1] - 2026-06-16

### Added
- Install runbook (`docs/installation.md`).
- README refresh and version sync.

---

## [0.11.0] - 2026-06-16

### Added
- Initial public release.
- `langgraph_dispatch`, `langgraph_inspect`, `langgraph_resume` tools.
- Phase 4 wake-via-CLI: agent woken in originating Slack thread on milestone/decision/HITL/terminal events.
- Phase 5 SSE subscriber: post-resume events continue to wake the agent (not fire-and-forget).
- Slack thread reply hint in wake messages.
- GitHub Actions CI (build, test, PR gates).
- `langgraph-bridge` skill for tool consumers.
