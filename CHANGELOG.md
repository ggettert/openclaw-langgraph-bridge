# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each entry references the originating PR. To find the exact commits, see the PR's `Files changed` tab or `git log --grep="#<pr-number>"`.

## [Unreleased]

## [0.15.0] - 2026-06-29

### Added

- **Per-event-class thinking level for proactive wakes (#100).** Milestone wakes are silent status nudges; with reasoning enabled they produced reasoning-only turns (thinking block, empty final content) that the OpenClaw runtime retried, churning the session queue and holding the lane longer than necessary. `wakeAgentAsync` now accepts an optional `--thinking` pass-through, and milestone-class wakes default to `thinking: "off"`. Configurable per event class via `deps.wakeThinking.{milestone,decision,hitl,terminal}`; `decision` / `hitl` / `terminal` inherit the session-configured reasoning level unless explicitly overridden. (#100, #103)

- **Per-flow wake-model pin to stop sonnet↔opus cache thrash (#101 ask #4).** Previously, the wake model was chosen per event-class: milestone wakes used `milestone_model` (e.g. `sonnet-4-6`) while decision / HITL / terminal wakes fell back to the session primary (e.g. `opus-4-8`). Across a single flow this caused the model to flip on nearly every wake, invalidating the Anthropic prompt cache and driving memory pressure (real incident 2026-06-29, flow `c92b1f92`, RSS ~1.68 GB).

  **Direction A (default — first-wake-model-wins):** the bridge now pins one model per `flow_id` on the first wake and reuses it for every subsequent wake of that flow, regardless of event class. This eliminates mid-flow flips while preserving the `milestone_model` cost optimisation (the cheaper model is used for *all* wakes, not just milestones).

  **Direction B (opt-in — `wakeModelPolicy: "session-primary"`):** set this dep to always use the session's primary model for every wake, including milestones. This provides maximum cache stability by never forwarding `milestone_model` at all, at the cost of the milestone cost-optimisation. Thread `deps.wakeModelPolicy` (optional, default `"first-wake"`) to choose the direction per deployment. Invalid/rejected `milestone_model` values (caught by the existing `invalidMilestoneModelFlows` degradation) are never re-pinned — the pin automatically switches to `undefined` (session primary) after the first rejection. The pin is GC'd on the flow's terminal event; post-terminal frames are still dropped by the existing terminal latch. (#105)

### Fixed

- **Durable per-`flow_id` terminal latch + `finish()` conflict hardening (#101).** Trailing milestone / terminal / `*:started` / `hitl` frames replayed after a flow had already completed (arriving seconds apart, *across stream boundaries* — e.g. after a `langgraph_resume`) could re-wake the session and wedge the lane until a manual gateway restart. The previous per-stream guard (#94) and the SDK-record terminal status both raced these replays. A synchronous, durable per-`flow_id` terminal latch — set the moment a terminal frame is processed, *before* `flows.finish()` — now drops any later frame for that `flow_id` before it can route to a wake, independent of the SDK record's revision/timing. `finish()` revision conflicts are also hardened: the current revision is re-read (numerically normalized) and `finish()` retried once so the terminal state still commits; a persistent failure is swallowed + warned rather than rethrown, since a terminal event has no productive retry and a 500 here is a misleading signal, not a re-delivery trigger (the latch already guarantees replay suppression). (#101, #104)

## [0.14.1] - 2026-06-26

### Fixed

- **Suppress post-terminal node-state replay frames (#94).** After a graph run emitted its terminal event, LangGraph's `stream_mode` could flush buffered node-state snapshots, causing trailing `merge_gate` / node `emit` frames to surface to the agent as phantom "post-terminal replays." The SSE read loop in `event-subscriber.ts` now tracks `terminalSeen` (separate from `sawTerminal`, set only on `terminal`-kind events) and drops subsequent non-terminal emit frames. `terminal`-kind frames are always forwarded — including a graph error frame arriving after a prior terminal (errors are classified as `kind: "terminal"`), so error detail is never swallowed. `hitl` is intentionally excluded — it is a pause/interrupt, not a completion, so frames after an interrupt are unaffected. (#94)

## [0.14.0] - 2026-06-26

### Added

- **Plugin-side wake budget + milestone dedup (#91).** Bounds how often a LangGraph workflow can wake the agent, fixing the per-frame wake storm that could wedge a session during a fleet run. *Phase 1* adds a per-flow sliding-window wake budget — a circuit breaker that caps wakes at `wakeBudget.maxWakesPerFlowPerWindow` (default 15) per `wakeBudget.windowMs` (default 60000) and coalesces overflow into a single trailing-edge wake. *Phase 2* adds same-key milestone dedup keyed on `(flow_id, phase, event)` within `dedup.windowMs` (default 5000; `dedup.enabled` default true), plus topology-agnostic parallel-fanout collapse (no hardcoded node names). Dedup keys are namespaced by `flow_id` so concurrent flows never collide, and per-flow state is pruned on the flow's terminal event. `decision` / `hitl` / `terminal` events always wake immediately and are never deduped or budgeted. Set `dedup.enabled=false` with a high `wakeBudget.maxWakesPerFlowPerWindow` to restore pre-#91 behaviour. (#91, #92)

### Security

- **F3 — Timing-safe webhook token comparison.** Replaced the `!==` string comparison in `webhook-handler.ts` with `crypto.timingSafeEqual` via a new `safeCompare(presented, expected)` helper. Prevents timing-oracle attacks that could allow an attacker to infer the `callbackToken` value byte-by-byte. Length-leak on mismatch is accepted (token has a fixed format). (#88)

### Fixed

- **F4 — AbortController wiring for SSE streams.** Both `langgraph_dispatch` and `langgraph_resume` now capture the `AbortController` returned by `dispatchAndStream` and call `.abort()` when the `runIdPromise` timeout fires or `onError` is invoked. A module-level `Set<AbortController>` tracks every open stream; a single idempotent `process.on('SIGTERM')` handler aborts all of them on graceful shutdown. (#88)
- **F5 — `summaryMaxChars` missing from `openclaw.plugin.json` configSchema.** Added the `summaryMaxChars` property (type `integer`, minimum 100, maximum 50000) to the hand-maintained plugin manifest so OpenClaw surfaces it in config validation and docs. The TypeBox `ConfigSchema` already declared the field; the manifest was out of sync. (#88)

## [0.13.1] - 2026-06-25

### Added
- `milestone_model` parameter on `langgraph_dispatch`. Forwarded as `--model <value>` to the `openclaw agent` CLI on milestone-event wakes only (e.g. `coder started`, `spec-reviewer finished`). Decision / HITL / terminal wakes always use the session's primary model and ignore this override. Lets callers trade reply quality for latency on high-frequency status events (e.g. set `milestone_model="anthropic/claude-sonnet-4-6"` while keeping the session on Opus). (#83, #84)

### Changed
- `wakeAgentAsync` gracefully degrades when the gateway rejects the `--model` value ("Model override X is not allowed for agent Y"). On rejection, the bridge logs a WARN, invokes the `onInvalidModel` callback, and retries the subprocess WITHOUT `--model` so the wake still lands on the session's primary model. The webhook handler caches the per-flow rejection so subsequent milestone wakes for the same flow skip the override entirely. (#83, #84)

## [1.0.0] - 2026-06-24

### Changed
- Distribution model: now publishes to npm and ClawHub via dedicated workflows. GitHub release tarball pipeline removed — install paths are now `clawhub:`, `npm:`, `git:`, or build-from-source.
- Package renamed to `@ggettert/openclaw-langgraph-bridge` (scoped).
- `openclaw` peer dependency bumped to `^2026.6.9` to pull security fixes for hono / undici / protobufjs / esbuild / tar transitive vulnerabilities.

### Added
- npm-publish.yml workflow with trusted publishing (OIDC, no token rotation).
- clawhub-publish.yml workflow. Requires `CLAWHUB_TOKEN` repo secret.
- CI version-sync check (`package.json` ↔ `openclaw.plugin.json`).
- `SECURITY.md` reintroduced as a 5-line pointer to GitHub Security Advisories. Friendlier discoverability than expecting users to find the Security section in README. (Issue #61, PR #63)
- CONTRIBUTING.md, CODE_OF_CONDUCT.md (PR #47)
- CHANGELOG.md (this file)
- `docs/workflow-contract.md` — canonical workflow integration guide for OSS users (PR #47)
- README badges: npm version, CI status, license (PR #47)
- Integration test suite covering end-to-end SSE and webhook flows. (PR #56, closes #49)

### Changed
- Relicensed from Apache 2.0 to MIT to match the OpenClaw ecosystem (core OpenClaw, ClawHub, and related repos are MIT). Sole copyright holder consented to relicense. (PR #58)
- Removed organizational references in docs/comments; copyright holder is now `Grace Gettert`. (PR #58)
- `decision_only` parameter now functions per its name. When `true` (default), milestone events update flow state silently but do **not** wake the agent. When `false`, milestone events also wake the agent. Decision, HITL, and terminal events always wake the agent regardless of this setting. (#6, PR #47)
- README Status section updated to stable pre-1.0 framing; links to CHANGELOG.md for migration notes (PR #47)
- `docs/installation.md` rewritten for OSS users: generic prereqs, install paths, full config reference, troubleshooting (PR #47)
- CONTRIBUTING.md trimmed and reorganized; Releases section added (PR #47)
- CONTRIBUTING.md "Where to File Things" — security row now points directly to GitHub Security Advisories (PR #47)
- Docs polish: workflow-contract.md, phase-event-contract.md, installation.md, README updated for OSS clarity. (PR #59)

### Removed
- `LanggraphClient.resumeRun()` — dead code with wrong wire format. Use `dispatchAndStream` for resume operations. (#8, PR #47)
- `SECURITY.md` — security disclosure is via GitHub Security Advisories (see README Security section and CONTRIBUTING.md). (PR #47)

### Fixed
- SSE stream non-abort errors mid-stream now invoke `onClose` so the dispatch/resume caller's synthetic-terminal fallback fires. Previously: a connection reset or LangGraph pod restart could leave the flow permanently in `"running"`.
- Concurrent `langgraph_resume` calls on the same flow_id no longer open duplicate SSE streams (#9, PR #62). The second concurrent call now returns `resume_already_in_progress` instead of racing through the TOCTOU window.
- Orphaned `queued` flow on dispatch failure now tombstoned so `langgraph_inspect` doesn't surface stale records. (#7, PR #47)
- `typebox` package replaced with canonical `@sinclair/typebox`. (#15, PR #47)
- Release tarball no longer ships devDependencies; `npm ci --omit=dev --omit=optional --omit=peer` + verification step in release workflow. (#23, PR #47)
- LangSmith Deployment and Fleet auth: `x-api-key` header now sent on all outbound LangGraph HTTP requests when `langgraphApiKey` is configured; `x-auth-scheme` sent alongside it when `langgraphAuthScheme` is also set. (#29, PR #57)

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
- Skill: cherry-picked `spec_path` branch requirement and post-resume replay guard from a downstream fork.
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
