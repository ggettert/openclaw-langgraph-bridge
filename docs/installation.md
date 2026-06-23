# Installation — openclaw-langgraph-bridge

Per-bot install runbook. Takes a working OpenClaw gateway and adds the bridge plugin so the agent can dispatch LangGraph workflows and be woken on milestones, HITL gates, and terminal events in the originating conversation thread.

**Audience:** Bot operator with shell access to the bot host.

**Time:** 5–10 minutes for a clean install.

---

## Supported channels

*The plugin is tested against Slack only.* Other OpenClaw channels (Discord, Telegram, WhatsApp, etc.) are *theoretically* supported because:

- The wire protocol (LangGraph dispatch / SSE event stream / webhook handler / wake-via-CLI) is channel-agnostic.
- The `openclaw agent --session-key` wake primitive routes to whichever channel the originating session was bound to.
- The only Slack-specific code is the `[reply-hint]` line emitted in wake messages for threaded channel sessions.

### Channel compatibility

| Channel | Status | Notes |
|---|---|---|
| Slack DM | ✅ Tested | Validated in production |
| Slack channel thread | ✅ Tested | Validated in production |
| Discord DM | 🟡 Untested | Wake should work; no reply-hint needed for DMs |
| Discord guild thread | 🟡 Untested | Wake should work; reply-hint needs a Discord-shaped session-key branch (~5 LOC) |
| Telegram | 🟡 Untested | Wake should work; same reply-hint caveat |
| Other channels | 🟡 Untested | Same shape as above |

**Want to use this plugin with a non-Slack channel?** Open an issue and PR with the per-channel `buildReplyHint` branch and we'll merge.

---

## Prerequisites

Verify each before starting.

1. **OpenClaw gateway** running and healthy (version `2026.5.17` or later):
   ```bash
   openclaw --version
   # v2026.5.17 or higher
   ```
2. **Node 22+** (needed for build-from-source path only; ClawHub and npm install paths handle this automatically):
   ```bash
   node --version  # v22.x.x
   ```
3. **A reachable LangGraph server** — the URL the plugin will dispatch to. Choose the deployment target that matches your setup:

   | Deployment target | API key needed? | Notes |
   |---|---|---|
   | `langgraph dev` (local POC) | No | Zero-config local dev server |
   | [Aegra](https://docs.aegra.dev) (self-hosted production) | No | Drop-in LangGraph server with Postgres + Redis |
   | [LangSmith Deployment](https://docs.smith.langchain.com/langgraph-platform) (LangChain's hosted LangGraph, cloud) | **Yes** | Set `langgraphApiKey` in plugin config (see below) |
   | LangSmith Fleet | **Yes** | Set both `langgraphApiKey` and `langgraphAuthScheme: "langsmith-api-key"` |

   For LangSmith Deployment or Fleet, generate an API key in the LangSmith dashboard (env var convention: `LANGGRAPH_API_KEY`) and supply it as `langgraphApiKey` in plugin config. Rotating `langgraphApiKey` requires a gateway restart for the new value to take effect (tool definitions cache config at plugin registration time).
4. **A `callbackToken`** — a pre-shared secret the plugin uses to authenticate inbound webhook POSTs. Generate one if you don't have one:
   ```bash
   openssl rand -hex 32
   ```
5. **`callbackPublicBaseUrl`** (recommended) — the public URL the LangGraph server can POST events to. The plugin appends `/plugins/openclaw-langgraph-bridge/events`. Without it the plugin still works via SSE only, but webhook-based wake events won't have a target.

---

## Install paths

### Path A: ClawHub (recommended for most users)

```bash
openclaw plugins install clawhub:@ggettert/openclaw-langgraph-bridge
```

ClawHub auto-discovers OpenClaw plugins from npm and verifies digest + signed provenance. Easiest path for production bots.

### Path B: npm

```bash
openclaw plugins install npm:@ggettert/openclaw-langgraph-bridge
```

For environments where ClawHub isn't configured or you want to pin via standard npm tooling.

### Path C: git (pre-release / unreleased builds)

```bash
openclaw plugins install git:github.com/ggettert/openclaw-langgraph-bridge#main
```

Useful for testing unreleased builds, pinning to a specific commit SHA, or working from a feature branch.

### Path D: Build from source

```bash
git clone https://github.com/ggettert/openclaw-langgraph-bridge.git
cd openclaw-langgraph-bridge
npm ci
npm run build
# Then point OpenClaw at the dist/ directory via plugins.entries config
```

For contributors only.

---

## Configure the plugin

Edit `~/.openclaw/openclaw.json` to register and enable the plugin.

### Add the config block

Under `plugins.entries.openclaw-langgraph-bridge`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-langgraph-bridge": {
        "enabled": true,
        "config": {
          "langgraphBaseUrl": "http://langgraph.example.com:2024",
          "callbackToken": "REPLACE_WITH_YOUR_TOKEN",
          "callbackPublicBaseUrl": "http://<your-bot-host>:<gateway-port>",
          "agentId": "main",
          "defaultTimeoutMs": 10000,
          "allowedWorkflows": []
        }
      }
    }
  }
}
```

### Config reference

| Key | Required | Default | Description |
|---|---|---|---|
| `langgraphBaseUrl` | ✓ | — | Base URL of your LangGraph server, e.g. `http://localhost:2024`. |
| `callbackToken` | ✓ | — | Pre-shared secret. Inbound webhook POSTs must supply `Authorization: Bearer <token>`. Generate with `openssl rand -hex 32`. |
| `callbackPublicBaseUrl` | — | — | Public base URL the LangGraph server POSTs events to. Plugin appends `/plugins/openclaw-langgraph-bridge/events`. Do **not** include the path here. |
| `agentId` | — | `"main"` | Agent id to wake when events fire. Default is right for single-agent bots. |
| `allowedWorkflows` | — | `[]` (all) | Optional allowlist of assistant ids / graph ids. When non-empty, unlisted workflows are refused. Empty or unset = all permitted. |
| `defaultTimeoutMs` | — | `10000` | Per-request timeout for the LangGraph HTTP client (ms). Bump for slow cold-start servers. |
| `summaryMaxChars` | — | `4000` | Maximum characters for event summaries in wake messages. Longer summaries are truncated with a ` …[truncated]` suffix. |
| `langgraphApiKey` | — | — | API key for LangSmith Deployment or Fleet. When set, sent as `x-api-key` on all outbound LangGraph HTTP requests. Not required for `langgraph dev` or Aegra deployments. |
| `langgraphAuthScheme` | — | — | Auth scheme sent as `x-auth-scheme` alongside `x-api-key`. Set to `"langsmith-api-key"` for LangSmith Fleet deployments. Leave unset for standard LangSmith Deployment, Aegra, or langgraph dev. |

### Allowlist hardening (`allowedWorkflows`)

If your bot should only drive specific workflows, set `allowedWorkflows` to a list of workflow ids (graph ids or assistant UUIDs):

```json
"allowedWorkflows": ["fleet", "pr_review"]
```

When set, `langgraph_dispatch` and `langgraph_inspect_workflow` refuse unlisted ids. `langgraph_list_workflows` still returns all workflows but marks blocked ones `allowed: false`. Limits blast radius if the agent is prompted toward an unintended workflow.

### Mark as load-allowed (only if `plugins.allow` is set)

If your gateway has an explicit `plugins.allow` allowlist, add the plugin id:

```json
{
  "plugins": {
    "allow": ["openclaw-langgraph-bridge", "..."]
  }
}
```

If `plugins.allow` is unset, skip this step.

---

## Restart the gateway and verify

### Restart

```bash
openclaw gateway restart
```

Or via systemd if running as a service:

```bash
sudo systemctl restart openclaw-gateway
```

### Verify tools are registered

```bash
openclaw plugins inspect openclaw-langgraph-bridge --runtime
# Should list the five tools: langgraph_dispatch, langgraph_inspect,
# langgraph_inspect_workflow, langgraph_list_workflows, langgraph_resume
```

Or check the log:

```bash
sudo journalctl -u openclaw-gateway -n 30 --no-pager | grep langgraph-bridge
# Expected:
# [plugins] openclaw-langgraph-bridge: registered POST /plugins/openclaw-langgraph-bridge/events
#   + langgraph_inspect + langgraph_resume tools (token configured: true)
```

`token configured: true` confirms `callbackToken` was read.

### Verify LangGraph is reachable

```bash
curl -sS -m 5 http://localhost:2024/ok
# Expected: {"ok":true}
```

### Verify webhook endpoint (if `callbackPublicBaseUrl` is set)

From a machine that would post events (often the LangGraph host itself):

```bash
curl -sS -m 5 -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"status","flow_id":"healthcheck","title":"webhook reachable"}' \
  http://<callbackPublicBaseUrl>/plugins/openclaw-langgraph-bridge/events
# Expected: {"error":"flow_not_found","flow_id":"healthcheck"}
# 404 is correct — it means auth passed and routing worked; the fake flow_id had no record.
```

If you get HTTP 401: wrong token. If you get a connection timeout: the gateway isn't reachable at `callbackPublicBaseUrl` from where you're testing.

---

## Connecting to LangGraph

### Local development

```bash
# Install langgraph CLI if needed
pip install langgraph-cli

# Start a local dev server from your graph repo
langgraph dev
# Default: http://localhost:2024
```

Set `langgraphBaseUrl: "http://localhost:2024"` in config.

### Self-hosted with Aegra

[Aegra](https://docs.aegra.dev) is a self-hosted, drop-in-compatible LangGraph server. Uses the same LangGraph SDK and Python graph definitions, adds Postgres for durable state and Redis for SSE pub/sub. Recommended for production with data-residency requirements.

Set `langgraphBaseUrl` to your Aegra deployment URL.

### LangSmith Deployment (cloud)

[LangSmith Deployment](https://docs.smith.langchain.com/langgraph-platform) (LangChain's hosted LangGraph) provides managed LangGraph hosting. Set `langgraphBaseUrl` to the deployment URL from the LangSmith dashboard, and set `langgraphApiKey` to the API key from your LangSmith account settings (env var: `LANGGRAPH_API_KEY`).

Example config:

```json
{
  "plugins": {
    "entries": {
      "openclaw-langgraph-bridge": {
        "enabled": true,
        "config": {
          "langgraphBaseUrl": "https://your-deployment.api.langsmith.com",
          "langgraphApiKey": "ls__your_api_key_here",
          "callbackToken": "REPLACE_WITH_YOUR_TOKEN",
          "callbackPublicBaseUrl": "http://<your-bot-host>:<gateway-port>"
        }
      }
    }
  }
}
```

The plugin sends `x-api-key: <langgraphApiKey>` on all outbound HTTP calls to the LangGraph server (thread creation, run dispatch, SSE stream, schema and assistant list endpoints).

For LangSmith Fleet deployments, also set `langgraphAuthScheme: "langsmith-api-key"` — Fleet requires both `x-api-key` and `x-auth-scheme: langsmith-api-key` headers.

> **⚠️ Verification status:** `langgraphApiKey` and `langgraphAuthScheme` are covered by unit tests against mocked HTTP only. As of v1.0, no end-to-end verification against a live LangSmith Deployment or Fleet endpoint has been performed. Please [file an issue](https://github.com/ggettert/openclaw-langgraph-bridge/issues) if you hit auth-related failures so we can pin down the wire-format quirk.

---

## Upgrade procedure

### ClawHub / npm install path

```bash
openclaw plugins upgrade @ggettert/openclaw-langgraph-bridge
openclaw gateway restart
```

### Build-from-source path

```bash
EXT_DIR=~/.openclaw/extensions/openclaw-langgraph-bridge
cd "$EXT_DIR"
git fetch --tags
git checkout vX.Y.Z
npm ci
npm run build
openclaw gateway restart
```

Check [CHANGELOG.md](../CHANGELOG.md) for migration notes before upgrading between minor versions.

---

## Uninstall

```bash
openclaw gateway stop
rm -rf ~/.openclaw/extensions/openclaw-langgraph-bridge
# Remove the config block from ~/.openclaw/openclaw.json
openclaw gateway start
```

In-flight LangGraph runs are **not** canceled by uninstalling the plugin. They continue on the LangGraph server until they reach a terminal state; the agent just won't be woken about them. Cancel via the LangGraph API directly before uninstalling if you want a clean stop.

---

## Troubleshooting

### Plugin doesn't appear in the loaded-plugins list

**Symptoms:** `journalctl | grep langgraph-bridge` shows nothing; tools aren't visible to the agent.

**Causes:**
- `plugins.allow` is set and doesn't include `openclaw-langgraph-bridge`
- `plugins.entries.openclaw-langgraph-bridge.enabled` is explicitly `false`
- `dist/index.js` is missing (build step didn't run; for source installs, run `npm run build`)
- Path mismatch: gateway expects `~/.openclaw/extensions/<plugin-id>/` where `<plugin-id>` must match the `id` field in `openclaw.plugin.json`

### `token configured: false` on startup

The `callbackToken` is not set or is set to an empty string. Inbound webhook POSTs will be **rejected with HTTP 503**. Set the token in config and restart.

### Wake events fire but the agent's reply lands at channel root (not in-thread)

Pre-v0.11.0 behavior. Confirm you're running v0.11.0+:

```bash
grep version ~/.openclaw/extensions/openclaw-langgraph-bridge/openclaw.plugin.json
```

### Wake events arrive in the wrong order (older events after newer ones)

Fixed in v0.12.3 (per-session FIFO wake queue). Upgrade to v0.12.3+.

### `flow_id` shows as `queued` in `langgraph_inspect` after a failed dispatch

Fixed in v1.0 (PR #47 / issue #7): orphaned `queued` flows are now tombstoned on dispatch failure. Upgrade to v1.0+.

### Milestone events wake the agent when `decision_only=true` (default)

Fixed in v1.0 (PR #47 / issue #6): `decision_only=true` now correctly suppresses milestone wakes. Upgrade to v1.0+.

### SSE truncates at a strange character boundary

Fixed in v0.12.3. Upgrade to v0.12.3+.

### `Cannot find module '@sinclair/typebox'` at startup

Fixed in the v1.0 launch-prep cycle (PR #47, issue #15). The `typebox` (unscoped) package was replaced with the canonical `@sinclair/typebox`. If you built from source, run `npm ci` again.

---

## Known open issues

For the live list, see the [issue tracker](https://github.com/ggettert/openclaw-langgraph-bridge/issues).

---

## References

- Plugin source: https://github.com/ggettert/openclaw-langgraph-bridge
- Workflow integration guide: [`docs/workflow-contract.md`](./workflow-contract.md)
- Skill for agents using these tools: `skills/langgraph-bridge/SKILL.md` (ships inside the install)
- Why not MCP: [`docs/why-this-not-mcp.md`](./why-this-not-mcp.md)
