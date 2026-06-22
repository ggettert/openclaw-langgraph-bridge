# Security Policy

## Supported Versions

Only the **latest minor release** receives security fixes.

| Version | Supported |
|---------|-----------|
| 0.12.x (current) | ✅ |
| < 0.12 | ❌ |

Pre-v1.0 releases are best-effort. After v1.0 we will define a more formal
support window.

## Reporting a Vulnerability

**Please do not file security issues publicly** — use one of the private
channels below so we can assess and patch before disclosure.

### Preferred: GitHub Security Advisories

[Report a vulnerability via GitHub Security Advisories](https://github.com/ggettert/openclaw-langgraph-bridge/security/advisories/new)

This is the fastest path. GitHub keeps the report private; we can draft a fix
and coordinate a release before anything is public.

### Fallback: Email

**security@\<TODO-domain\>** _(maintainer will fill this in before v1.0 launch)_

Include as much detail as you can:
- Steps to reproduce
- What data / tokens / credentials are at risk
- Your assessment of severity and exploitability

## What We Consider a Vulnerability

- **Callback token exposure** — the `callbackToken` reaching LangGraph metadata,
  URL paths, query strings, or logs in any form
- **Command injection** in skill invocation or subprocess calls triggered by
  webhook events
- **Unsanitized passthrough to LangGraph** — attacker-controlled data from a
  webhook reaching a LangGraph run's metadata or state in a way that allows
  privilege escalation or SSRF
- **Secret leak in logs** — tokens, session keys, or bearer credentials
  appearing in plugin log output at any log level
- **Authentication bypass** — a way to POST to the webhook route without a
  valid `callbackToken`

## Response Timeline

We aim to acknowledge reports within **72 hours** and provide a fix or
meaningful update within **14 days**. Pre-v1.0 there is no formal SLA.
We will communicate honestly if a fix will take longer.

## Disclosure Policy

We follow **coordinated disclosure**:

1. Reporter files a private advisory or email.
2. Maintainers reproduce and assess severity.
3. A fix is developed on a private branch.
4. A patch release is cut and distributed.
5. The advisory is made public (typically **90 days** after initial report,
   or sooner if a fix is shipped).

If a critical issue is already known to be actively exploited, we may
accelerate this timeline.

## Scope

**In scope:**
- Plugin source code in this repository
- Recommended plugin configuration as documented in `docs/installation.md`

**Out of scope:**
- Misconfigurations that users deliberately impose (e.g. leaving
  `callbackToken` unset in a public deployment)
- Third-party plugin chains interacting with this plugin
- Vulnerabilities in LangGraph upstream — report those to the LangGraph
  maintainers directly
- OpenClaw gateway core — report those to the OpenClaw maintainers

## No Bug Bounty

This is a pre-revenue open-source project. We do not offer a paid bug bounty
program. We will credit researchers in release notes and the advisory unless
they prefer to remain anonymous.
