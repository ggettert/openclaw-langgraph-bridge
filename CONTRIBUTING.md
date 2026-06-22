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
- One `.test.ts` file per source file (e.g. `src/webhook-handler.test.ts`
  covers `src/webhook-handler.ts`)
- Mock I/O at the boundary — subprocess/fs/fetch calls are mocked; no real
  network in unit tests
- `processEvent` and classifiers are pure functions — test them directly
  without spinning up the HTTP layer
- Keep tests deterministic; avoid `setTimeout` in tests unless you control the
  clock via `vi.useFakeTimers()`

## Smoke Tests (manual, against a real LangGraph)

Unit tests cover the plugin's internal logic. To exercise the plugin against a real LangGraph server (useful for verifying integration behavior, debugging webhook delivery, or reproducing user-reported bugs), three smoke scripts are available:

```bash
# Requires a LangGraph server at LANGGRAPH_BASE_URL (default http://localhost:2024)
npm run smoke           # langgraph-sdk dispatch + inspect smoke
npm run smoke:webhook   # webhook handler against a real flow
npm run smoke:streaming # SSE subscriber + event classifier smoke
```

Smoke tests are NOT run in CI — they require a LangGraph server and external network access. Run them manually when:
- Modifying the wire-format code in `src/langgraph-client.ts`
- Changing how events are classified or routed
- Reproducing a user-reported bug that doesn't surface in unit tests

## Branch & Commit Conventions

We use **[Conventional Commits](https://www.conventionalcommits.org/)**:

```
feat:     new user-facing capability
fix:      bug fix
docs:     documentation only
chore:    build, CI, dependency updates
refactor: code restructure, no behavior change
test:     adding or updating tests
```

Branch off `main`:

```bash
git checkout main && git pull --ff-only
git checkout -b feat/your-feature-name   # or fix/, docs/, etc.
```

Squash noisy WIP commits before opening a PR. Each commit in the final branch
should be a coherent unit of change with a meaningful subject line.

## Pull Request Conventions

- **Title:** Conventional-commit style (`fix: tombstone orphaned flow on dispatch failure`)
- **Body:** Describe *what* changed and *why*. If the PR addresses an issue,
  link it: `Closes #7`.
- **CI:** All checks must be green before merge — `npm test` and `npm run build`
  run on every push via `.github/workflows/ci.yml`.
- **Size:** Keep PRs focused. A 200-line fix is easier to review than a 2000-line
  omnibus. If you're doing multiple things, split them into separate PRs or at
  least separate commits.
- **Review:** At least one maintainer approval is required to merge to `main`.

## Where to File Things

| What | Where |
|------|-------|
| Bug reports | [GitHub Issues](https://github.com/ggettert/openclaw-langgraph-bridge/issues) |
| Feature requests | [GitHub Issues](https://github.com/ggettert/openclaw-langgraph-bridge/issues) with the `enhancement` label |
| Questions | [GitHub Discussions](https://github.com/ggettert/openclaw-langgraph-bridge/discussions) — or Issues tagged `question` if Discussions are not enabled |
| Security vulnerabilities | See [SECURITY.md](./SECURITY.md) — **do not file publicly** |

## License / DCO

No CLA required. By contributing you agree that your contributions are
licensed under the project's [Apache 2.0 license](./LICENSE), per Apache 2.0
section 5 ("Submission of Contributions"). The standard inbound=outbound
licensing model applies.

## Code of Conduct

This project follows the [Contributor Covenant v2.1](./CODE_OF_CONDUCT.md).
Please read it before participating. We take it seriously.
