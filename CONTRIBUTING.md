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
licensed under the project's [Apache 2.0 license](./LICENSE), per Apache 2.0
section 5 ("Submission of Contributions"). The standard inbound=outbound
licensing model applies.

## Code of Conduct

This project follows the [Contributor Covenant v2.1](./CODE_OF_CONDUCT.md).
Please read it before participating. We take it seriously.
