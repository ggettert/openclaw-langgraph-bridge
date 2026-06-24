# Contributing to openclaw-langgraph-bridge

Thank you for your interest in contributing! This document covers how to get
set up, how we work, and where to direct different kinds of feedback.

## Dev Setup

**Prerequisites:** Node.js 22+ (this is the version we test against in CI; earlier versions may work but are not guaranteed). npm comes bundled with Node.

External contributors: fork the repo on GitHub first, then clone your fork:

```bash
gh repo fork ggettert/openclaw-langgraph-bridge --clone
cd openclaw-langgraph-bridge
npm install
npm test        # runs the full vitest suite — expect all green
npm run build   # TypeScript → dist/
```

Maintainers can clone the upstream directly:

```bash
git clone https://github.com/ggettert/openclaw-langgraph-bridge.git
cd openclaw-langgraph-bridge
npm install
npm test
npm run build
```

The plugin talks to a LangGraph server. For local testing against a real graph, copy `openclaw.plugin.json` into your OpenClaw config and point `langgraphBaseUrl` at a local dev server (e.g. `langgraph dev` or a self-hosted Aegra instance).

## Test Conventions

- Test runner: **[vitest](https://vitest.dev)** (`npm test` or `npx vitest run`)
- `npm run test:watch` runs vitest in interactive watch mode for iterative dev.
- One `.test.ts` file per source file (e.g. `src/webhook-handler.test.ts` covers `src/webhook-handler.ts`)
- Mock I/O at the boundary — subprocess/fs/fetch calls are mocked; no real network in unit tests
- `processEvent` and classifiers are pure functions — test them directly without spinning up the HTTP layer
- Keep tests deterministic; avoid `setTimeout` in tests unless you control the clock via `vi.useFakeTimers()`

> Do not hardcode the test count in user-facing docs. Reference the CI badge or "full suite passes" instead.

### Integration Tests

Tests in `src/integration/` exercise the plugin against a real LangGraph server.
They are **skipped silently** when neither `LANGGRAPH_BASE_URL` nor
`RUN_INTEGRATION` is set, so `npm test` (unit-only) always runs fast and clean
without making any network calls.

```bash
npm run test:integration          # integration only (auto-skips if no LangGraph)
npm run test:all                  # unit + integration
```

#### Enabling integration tests locally

You need a running LangGraph server with the `integration-stub` assistant registered.
The easiest way is the example graph included in this repo:

```bash
# Terminal 1 — start the stub server
pip install langgraph-cli
cd examples/integration-test-graph
langgraph dev --no-browser
# Server listens on http://localhost:2024

# Terminal 2 — run the tests
RUN_INTEGRATION=1 npm run test:integration
# or equivalently:
LANGGRAPH_BASE_URL=http://localhost:2024 npm run test:integration
```

**Either env var enables the tests:**
- `LANGGRAPH_BASE_URL` — set this when pointing at a non-default host
  (e.g. a LangSmith Deployment or staging server).
- `RUN_INTEGRATION=1` — set this when using the default `localhost:2024` and
  you don't need to override the URL.

Without at least one of these, `isLangGraphReachable()` short-circuits without
any network call. This is intentional — it keeps `npm test` completely offline.

#### Assistant requirement

Integration tests target the assistant id stored in `LANGGRAPH_WORKFLOW`
(default: `integration-stub`).  If the server is reachable but that assistant
is not registered, you'll see a clear `[integration]` warning and the describe
blocks will be skipped.

To register the default assistant:
```bash
cd examples/integration-test-graph && langgraph dev --no-browser
```

To target a different assistant:
```bash
LANGGRAPH_WORKFLOW=my-graph npm run test:integration
```

#### Optional: authentication

When running against a secured server (LangSmith Deployment, etc.) pass:

```bash
LANGGRAPH_API_KEY=lsv2_...  npm run test:integration
# Optionally also:
LANGGRAPH_AUTH_SCHEME=Bearer  npm run test:integration
```

Both are optional; omit them for unauthenticated local dev servers.

#### CI

CI runs integration tests in a dedicated job (`integration`) that:
1. Starts `examples/integration-test-graph` via `langgraph dev --no-browser`.
2. Waits for the server to be ready.
3. Runs `npm run test:integration`.
4. **Asserts at least one test ran and passed** — a zero-test result fails the job
   loudly (prevents false-green checks).

The job is blocking (not `continue-on-error`) — if the server fails to start,
the job fails visibly rather than silently succeeding with zero tests.

The integration tests live in `src/integration/`. When adding a new one, add
the availability guard at the top of the file:

```typescript
import { isLangGraphReachable } from "./helpers.js";
const reachable = await isLangGraphReachable();
describe.skipIf(!reachable)("My suite (integration)", () => { ... });
```

#### HITL integration tests

The HITL integration tests (`src/integration/hitl.integration.test.ts`) target
a second example graph at `examples/hitl-stub-graph/`. Two tests cover the full
lifecycle: `approve` (happy-path terminal) and `block_revise` with feedback echo
(validates that `normalizeResumePayload` produced the right `{decision, feedback}`
shape and that feedback survived through the graph state to the `done` node).

#### Multi-node updates frame integration test

The multi-node test (`src/integration/multi-node-updates.integration.test.ts`)
targets a third graph at `examples/multi-node-stub-graph/`. It documents the
observed bridge behavior when LangGraph fans out to parallel branches: as of
LangGraph 0.2.x, parallel branches are reported in separate updates frames (not
batched), so the bridge emits one milestone per branch.

The combined `langgraph.json` in `examples/integration-test-graph/` now registers
**three** assistants — `integration-stub`, `hitl-stub`, and `multi-node-stub` — from
a single `langgraph dev` invocation. Override workflow ids with:

- `LANGGRAPH_HITL_WORKFLOW=<id>` — override the HITL graph
- `LANGGRAPH_MULTI_NODE_WORKFLOW=<id>` — override the multi-node graph

## Branch & Commit Conventions

We use **[Conventional Commits](https://www.conventionalcommits.org/)**: `feat | fix | docs | chore | refactor | test`.

Branch off `main`:

```bash
git checkout main && git pull --ff-only
git checkout -b feat/your-feature-name   # or fix/, docs/, etc.
```

Squash noisy WIP commits before opening a PR.

## Pull Request Conventions

- **Title:** Conventional-commit style (`fix: tombstone orphaned flow on dispatch failure`)
- **Body:** Describe *what* changed and *why*. If the PR addresses an issue, link it: `Closes #7`.
- **CI:** All checks must pass before merge.
- Small, focused PRs preferred.
- At least one maintainer approval is required to merge to `main`.

## Where to File Things

| What | Where |
|------|-------|
| Bug reports | [GitHub Issues](https://github.com/ggettert/openclaw-langgraph-bridge/issues) |
| Feature requests | [GitHub Issues](https://github.com/ggettert/openclaw-langgraph-bridge/issues) with the `enhancement` label |
| Questions | [GitHub Discussions](https://github.com/ggettert/openclaw-langgraph-bridge/discussions) — or Issues tagged `question` |
| Workflow integration questions | [docs/workflow-contract.md](./docs/workflow-contract.md) covers the plugin–workflow interface; open an Issue if the doc doesn't answer your question |
| Security vulnerabilities | [GitHub Security Advisories](https://github.com/ggettert/openclaw-langgraph-bridge/security/advisories/new) — **do not file publicly** |

## Releases

**Releases are maintainer-only.**

### How releases work

Releases are triggered by pushing a `v*` tag to `main`. The release workflow (`.github/workflows/release.yml`) handles the rest automatically:

1. Installs dependencies and builds TypeScript → `dist/`.
2. Runs the full test suite.
3. Re-installs with runtime-only deps (`npm ci --omit=dev --omit=optional --omit=peer`) so the tarball ships a clean `node_modules/`.
4. Packages the release tarball (`dist/`, `node_modules/`, `openclaw.plugin.json`, `package.json`, `README.md`, `docs/`, `skills/`).
5. Verifies the tarball excludes known dev packages (guards against issue #23 regressing).
6. Creates a GitHub Release with the tarball attached and auto-generated release notes.

### Pre-release checklist

Before tagging:
- [ ] `CHANGELOG.md` updated with all changes going into this release.
- [ ] CI is green on `main`.
- [ ] Version bumped in `package.json` and `openclaw.plugin.json`.

### Tagging

```bash
git checkout main && git pull --ff-only
git tag vX.Y.Z
git push origin vX.Y.Z
```

### Versioning policy

[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0 conventions:
- **Patch** (`0.Y.Z+1`): bugfix only; no breaking changes.
- **Minor** (`0.Y+1.0`): may include breaking changes. Note them in `CHANGELOG.md` under `### Changed` or `### Removed`.

After v1.0 we will adopt the standard SemVer guarantee (breaking changes = major bump).

### Recovery

If a release tag is wrong (wrong commit, broken build):

```bash
# Delete the GitHub Release via the UI or gh CLI first, then:
git tag -d vX.Y.Z
git push origin --delete vX.Y.Z
# Re-tag at the correct commit and push
git tag vX.Y.Z <correct-sha>
git push origin vX.Y.Z
```

## License / DCO

No CLA required. By contributing you agree that your contributions are
licensed under the project's [MIT license](./LICENSE). The standard inbound=outbound
licensing model applies.

## Code of Conduct

This project follows the [Contributor Covenant v2.1](./CODE_OF_CONDUCT.md).
Please read it before participating. We take it seriously.
