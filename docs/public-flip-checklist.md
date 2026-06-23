# Public-flip checklist

Working doc for the hardening + scaffolding work needed before flipping this
repo from private to public. Tracked in issue #66.

This doc captures the _reasoning_ behind each phase. The issue captures the
_work items_. Update both when you make decisions or finish steps.

## Why a checklist

Going public changes the threat model:

- Anyone can open a PR. CI becomes a structural defense, not a courtesy.
- Drive-by PRs from strangers may try to exploit `paths-ignore` patterns.
- External contributors expect required checks and a CODEOWNERS file.
- Fork PRs do not receive access to secrets — workflows that need them must
  handle that gracefully.

## Phase 1 — CI restructure

### Current state (paths-ignore on trigger)

`.github/workflows/ci.yml` uses `paths-ignore` on the `push` and `pull_request`
triggers. When the diff is docs-only, the workflow simply does not run.

This works while the repo is private and no required status checks are
configured. It will _break_ the moment we enable required status checks,
because the check name never posts and GitHub blocks merge with
"Expected — Waiting for status to be reported".

### Target state (paths-filter + summary checks)

Restructure into a two-stage flow:

1. `detect-changes` job (always runs) uses
   [`dorny/paths-filter@v3`](https://github.com/dorny/paths-filter)
   to classify the diff:
   - `code` — anything that affects build/test (src/, package.json, tsconfig, workflows, etc.)
   - `docs-only` — markdown, docs/, LICENSE, etc.
2. `build-and-test` job (matrix) gates on
   `if: needs.detect-changes.outputs.code == 'true'`, with a fallback
   step `if: needs.detect-changes.outputs.code != 'true'` that prints
   "no code changes — skipped" and exits 0.

The check names (`Build & Test (Node 22.x on ubuntu-latest)`, etc.) post
unconditionally — they just say SUCCESS quickly when there's no code work.

Same shape for the `integration` job.

## Phase 2 — Branch protection

Enable on `main` after Phase 1 is verified working.

Settings:

- Require PR before merging
- Require ≥1 approval (Grace can self-approve via GitHub web UI)
- Dismiss stale approvals when new commits are pushed
- Require conversation resolution
- Require linear history (squash or rebase only; no merge commits)
- Block force pushes
- Block deletions
- Restrict pushes to admins

Required status checks (after Phase 1):

- `Build & Test (Node 22.x on ubuntu-latest)` — picked as the gating combo;
  other matrix slots stay informational so we don't double-pay
- `Integration Tests (LangGraph dev)` — only if Phase 1 makes it reliable

## Phase 3 — Contributor scaffolding

### CODEOWNERS

`.github/CODEOWNERS`:

```
* @ggettert
```

Add more owners or scope by path when other maintainers join.

### Dependabot

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 3
```

Grace decides separately whether to enable Dependabot security updates
(auto-PRs for vulnerable deps). Recommended yes for public repos.

### Code scanning (CodeQL)

`.github/workflows/codeql.yml.disabled` exists from an earlier round when
GHAS wasn't available on this repo. Public repos get GHAS for free —
rename the file back to `codeql.yml` after the public flip.

## Phase 4 — Pre-flip audit

Run before flipping:

```bash
# Confirm no org-specific references slipped back in
grep -rn -i "carpe\|carpedata\|carpe\.io" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist

# Confirm no internal hostnames or paths
grep -rn -i "\.local\b\|internal\." . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist

# Check for stale secrets / tokens that might have committed by accident
git log --all --full-history -p | grep -iE "(api[_-]?key|secret|token|password)" | grep -v -E "(test|example|placeholder|<your|REPLACE_)" | head -20
```

Also:

- Re-read README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT with an outsider's eye
- Decide v1.0.0 release timing — flip the repo and ship the tag together, or
  flip first and tag later?
- Confirm the npm + ClawHub Path C / Path D work mentioned in CHANGELOG is
  either ready to ship or clearly marked future

## Phase 5 — Flip

Once Phases 1-4 are done:

1. Settings → Danger Zone → Change visibility → Public
2. Verify Dependabot alerts and secret scanning are on (default for public)
3. Restore `codeql.yml`
4. Optional: tag `v1.0.0`, let release workflow publish the tarball
5. Optional: announce, submit SKILL.md to ClawHub (see issue #60)

## When to redo Phase 1

If we ever decide to ship to npm and CI starts running publish workflows
on tag pushes, revisit Phase 1 — publish workflows may need to remain
unconditional even on docs-only PRs to a tag.
