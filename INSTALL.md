# INSTALL.md — openclaw-langgraph-bridge

Per-bot install runbook for v0.11.0+. Takes a working OpenClaw gateway and adds the bridge plugin so the agent can dispatch LangGraph workflows and be woken on milestones / HITL / terminal events in-thread.

**Audience:** Carpe bot operator with shell access to the bot host. Walks through fresh install on a bot that has never had the plugin before.

**Time:** 5-10 minutes for a clean install. Add 5 min if you need to configure auth tokens.

---

## Prerequisites

Verify each before starting. Don't proceed if any are missing.

1. **OpenClaw gateway running and healthy:**
   ```bash
   sudo systemctl status openclaw-gateway --no-pager | head -5
   # Active: active (running)
   ```
2. **Gateway version compatible** (plugin peerDep is `openclaw >= 2026.5.17`):
   ```bash
   openclaw --version
   ```
3. **Node 22+ available** (for build-from-source path; not needed for tarball path):
   ```bash
   node --version  # v22.x.x
   ```
4. **`gh` CLI authenticated** to a token with `read:packages` and read access to either `ggettert/openclaw-langgraph-bridge` (upstream) or `carpe/openclaw-langgraph-bridge` (Carpe fork). For Carpe bots, use the Carpe GitHub App token.
5. **Reachable LangGraph server URL** — the URL the plugin will dispatch to. Note this; you'll need it for config. Default Carpe POC: `http://10.41.1.198:2024`.
6. **A pre-shared `callbackToken`** — a string the LangGraph workflow will include as `Authorization: Bearer <token>` on inbound webhook POSTs. Generate one if you don't have it:
   ```bash
   openssl rand -hex 32
   ```
7. **`callbackPublicBaseUrl`** (if you want webhooks, recommended) — the URL the LangGraph server will reach this bot at. Plugin appends `/plugins/openclaw-langgraph-bridge/events`. For Kit's bot this is `http://10.41.3.60:18794`; for a new bot, find its gateway public/private IP + port.

---

## Path A: install from release tarball (recommended)

This is the production path. Skip Path B unless you specifically want to build from source.

### A1. Download and extract

Choose ONE source — they're built from the same commit:

```bash
# Carpe fork (use Carpe org auth)
EXT_DIR=~/.openclaw/extensions/openclaw-langgraph-bridge
mkdir -p "$EXT_DIR"
gh release download v0.11.0 \
  --repo carpe/openclaw-langgraph-bridge \
  --pattern 'openclaw-langgraph-bridge-v0.11.0.tar.gz' \
  --output /tmp/oclb.tgz
tar -xzf /tmp/oclb.tgz -C "$EXT_DIR"
rm /tmp/oclb.tgz
```

OR:

```bash
# Upstream (personal repo — same content)
gh release download v0.11.0 \
  --repo ggettert/openclaw-langgraph-bridge \
  --pattern 'openclaw-langgraph-bridge-v0.11.0.tar.gz' \
  --output /tmp/oclb.tgz
tar -xzf /tmp/oclb.tgz -C ~/.openclaw/extensions/openclaw-langgraph-bridge
rm /tmp/oclb.tgz
```

The tarball is **flat** — extracts `dist/`, `openclaw.plugin.json`, `package.json`, `README.md` directly into the target dir. No leading versioned folder.

### A2. Verify the extracted files

```bash
ls ~/.openclaw/extensions/openclaw-langgraph-bridge
# Expected: dist/  openclaw.plugin.json  package.json  README.md
grep '"version"' ~/.openclaw/extensions/openclaw-langgraph-bridge/openclaw.plugin.json
# Expected: "version": "0.11.0",
```

Skip to **Step 3 (configure)** below.

---

## Path B: build from source

For development bots or when you need a specific commit not yet released.

```bash
EXT_DIR=~/.openclaw/extensions/openclaw-langgraph-bridge
mkdir -p "$EXT_DIR"
cd "$EXT_DIR"
gh repo clone carpe/openclaw-langgraph-bridge . -- --depth=1
npm ci
npm run build
npm test  # should report 85+ passing
```

The repo's source files end up in `$EXT_DIR` directly. The gateway loads `dist/index.js` per `package.json`'s `openclaw.extensions` field, so source-level files coexisting in the same dir is fine.

---

## Step 3. Configure the plugin

Edit `~/.openclaw/openclaw.json` to register and enable the plugin. The two places that need changes:

### 3a. Register a config block

Add or merge under the `plugins.entries.openclaw-langgraph-bridge` path:

```json
{
  "plugins": {
    "entries": {
      "openclaw-langgraph-bridge": {
        "enabled": true,
        "config": {
          "langgraphBaseUrl": "http://<your-langgraph-base-url>:2024",
          "callbackToken": "REPLACE_WITH_YOUR_TOKEN",
          "callbackPublicBaseUrl": "http://<this-bot-private-ip>:<gateway-port>",
          "agentId": "main",
          "defaultTimeoutMs": 10000,
          "allowedWorkflows": []
        }
      }
    }
  }
}
```

> **Optional hardening: `allowedWorkflows`.** If your bot should only be able to drive specific LangGraph workflows, set this to an allowlist of workflow ids (graph ids or assistant UUIDs). When set, `langgraph_dispatch`, `langgraph_inspect_workflow`, and `langgraph_list_workflows` enforce it — disallowed workflows return `{ status: "error", reason: "workflow_not_allowed" }`. For `langgraph_list_workflows`, blocked workflows are still visible but annotated with `allowed: false`. Leave empty (`[]`) or unset to permit all workflows on the configured LangGraph server.
>
> Example: `"allowedWorkflows": ["fleet", "pr_review"]` — the bot can dispatch those two workflows; any other id is refused.

Key-by-key:

- `langgraphBaseUrl` — required. The LangGraph endpoint.
- `callbackToken` — required. Bearer token for inbound webhooks. Keep secret.
- `callbackPublicBaseUrl` — recommended. Without it, the plugin still works via the SSE-only path, but workflow-side webhook callbacks (used for redundancy) won't have a target. **Do NOT include the path `/plugins/...`** — the plugin appends it.
- `agentId` — the OpenClaw agent id to wake when events fire. Default `"main"` is right for single-agent bots. For multi-agent gateways, set this to the agent that should receive the wake.
- `defaultTimeoutMs` — the LangGraph HTTP client timeout. Bump if your LangGraph endpoint is slow on cold start.
- `allowedWorkflows` — optional hardening. Allowlist of assistant ids or graph ids the agent is permitted to dispatch, inspect, or list. When non-empty, any workflow id not in the list is refused. Empty array or omitting the key entirely permits all workflows. **Why use it:** limits blast radius if the agent is prompted toward an unintended workflow. Recommended for production bots wired to more than one workflow.

### 3b. Mark the plugin as load-allowed (only if `plugins.allow` is set)

If your gateway has `plugins.allow` populated (an explicit allowlist), add the plugin id:

```json
{
  "plugins": {
    "allow": ["openclaw-langgraph-bridge", "... other ids ..."]
  }
}
```

If `plugins.allow` is empty/unset, the plugin auto-loads from the extensions directory and you can skip this step.

### 3c. Restart the gateway

The plugin loads on gateway startup, so changes require a bounce:

```bash
sudo systemctl restart openclaw-gateway
```

Watch the log for plugin registration:

```bash
sudo journalctl -u openclaw-gateway -n 30 --no-pager | grep langgraph-bridge
# Expected:
# [plugins] openclaw-langgraph-bridge: registered POST /plugins/openclaw-langgraph-bridge/events
#   + langgraph_inspect + langgraph_resume tools (token configured: true)
```

`token configured: true` confirms the `callbackToken` was read.

---

## Step 4. Verify

### 4a. Tools are visible to the agent

In the bot's primary session (DM the bot, or a thread it's bound to), ask:

> "List your tools that contain 'langgraph' in the name."

Expected: the agent reports `langgraph_dispatch`, `langgraph_inspect`, `langgraph_resume`.

### 4b. LangGraph is reachable

From the bot host:

```bash
curl -sS -m 5 http://<langgraphBaseUrl>/ok
# Expected: {"ok":true}
```

If this times out: the LangGraph server is unreachable from this bot. Fix the network path before continuing. Symptom of doing so: dispatches hang for `defaultTimeoutMs` then error.

### 4c. Webhook endpoint is reachable (if `callbackPublicBaseUrl` is set)

From a machine that LangGraph would dispatch from (often the LangGraph server itself):

```bash
curl -sS -m 5 -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"status","flow_id":"healthcheck","title":"webhook reachable"}' \
  http://<callbackPublicBaseUrl>/plugins/openclaw-langgraph-bridge/events
# Expected: {"error":"flow_not_found","flow_id":"healthcheck"}
# That 404 is correct — it means auth passed and routing worked; the fake flow id had no record.
```

If you get `unauthorized` (401): wrong token. If you get connection timeout: the bot isn't reachable at `callbackPublicBaseUrl` from where you're testing.

### 4d. Verify allowlist (if `allowedWorkflows` is configured)

If you set `allowedWorkflows`, verify enforcement is active by asking the agent:

> "List available LangGraph workflows."

The agent should call `langgraph_list_workflows()` and surface a list where some workflows are marked `allowed: false`. If everything is marked `allowed: true`, your allowlist is either unset or matched too broadly.

### 4e. End-to-end smoke test (optional, requires a known workflow)

If the LangGraph server has the `fleet` workflow available and you have a `spec_path` in some repo:

> "Dispatch fleet workflow for ticket TEST-1 in `<some-repo>` with spec path `<some-existing-spec-path.md>`."

The agent should call `langgraph_dispatch`, return a `flow_id`, then yield. Within a few minutes you should be woken with at least a milestone event. If nothing happens within 5 min and the LangGraph thread state shows progress, the wake path is broken — check `agentId` matches your bot's actual agent id and that `openclaw agent --agent <id> --message test` works manually.

---

## Common installation problems

### Plugin doesn't appear in the loaded-plugins list

Symptom: `journalctl -u openclaw-gateway | grep langgraph-bridge` shows nothing.

Causes:
- `plugins.allow` is set and doesn't include `openclaw-langgraph-bridge`
- `plugins.entries.openclaw-langgraph-bridge.enabled` is `false` (default is `true` when the entry exists, but explicit false overrides)
- The extension directory is missing `dist/index.js` or `package.json`'s `openclaw.extensions` field
- Path mismatch — gateway expects `~/.openclaw/extensions/<plugin-id>/` (matching `id` from `openclaw.plugin.json`)

### `token configured: false` on startup

Symptom: log shows `... (token configured: false)`.

Cause: `callbackToken` not set in config, or set to an empty string. Inbound webhooks will be **rejected with 503**. Fix the config and restart.

### Wake events fire but the agent's reply lands at channel root, not in-thread

Symptom: for channel-thread sessions, you see the wake in-thread but the agent's response appears at channel root.

Cause: pre-v0.11.0 plugin behavior. The wake message must include a `[reply-hint]` line that the agent follows. Confirm v0.11.0+ is installed:

```bash
grep version ~/.openclaw/extensions/openclaw-langgraph-bridge/openclaw.plugin.json
# Expected: "version": "0.11.0"
```

### "Too many arguments for this command" in gateway log near plugin load

Unrelated red herring — that's the systemd `ExecStartPost` restart-notify hook on the gateway service, not the plugin. Fix it separately by editing the unit's `ExecStartPost` quoting. It does not affect plugin operation.

---

## Upgrade procedure

From an installed v0.11.0 to a future v0.12.0:

```bash
# Download new tarball over existing extension dir (overwrites dist/, openclaw.plugin.json, package.json, README.md)
EXT_DIR=~/.openclaw/extensions/openclaw-langgraph-bridge
gh release download vX.Y.Z --repo carpe/openclaw-langgraph-bridge \
  --pattern 'openclaw-langgraph-bridge-vX.Y.Z.tar.gz' \
  --output /tmp/oclb.tgz
tar -xzf /tmp/oclb.tgz -C "$EXT_DIR"
rm /tmp/oclb.tgz

# Bounce gateway
sudo systemctl restart openclaw-gateway

# Verify
sudo journalctl -u openclaw-gateway -n 20 --no-pager | grep langgraph-bridge
grep version "$EXT_DIR/openclaw.plugin.json"
```

No in-place migration is required for v0.11.0 → v0.12.0+ unless a future release ships a breaking change (which would land with explicit upgrade notes).

---

## Uninstall

```bash
# Stop using it
sudo systemctl stop openclaw-gateway
# Remove the extension dir
rm -rf ~/.openclaw/extensions/openclaw-langgraph-bridge
# Remove the config block from openclaw.json (manually edit ~/.openclaw/openclaw.json)
# Restart
sudo systemctl start openclaw-gateway
```

In-flight LangGraph runs are NOT canceled by uninstall. They continue on the LangGraph server until they hit a terminal state. The agent just won't be woken about them anymore. To clean up: cancel via the LangGraph API directly before uninstalling, or accept the orphan.

---

## Known issues at v0.12.0

Fixed in v0.12.0 (was open at v0.11.x):
- ~~**#18**: No way for an agent to introspect a workflow's schema before dispatching.~~ Fixed: `langgraph_inspect_workflow` tool.
- ~~**#19**: Skill didn't teach the introspect-before-dispatch pattern.~~ Fixed: skill update.
- ~~**#20 (umbrella)**: Multi-workflow support was incomplete.~~ Fixed: `langgraph_list_workflows` discovery tool, `langgraph_inspect_workflow` schema tool, `allowedWorkflows` enforcement extended across all tools, allowlist visibility documented.

Fixed in v0.11.2 (was open at v0.11.0/v0.11.1):
- ~~**#14**: Release tarball was missing `node_modules` — silent plugin load failure on install.~~ Fixed: release tarball now bundles runtime deps via `npm ci --omit=dev`.
- ~~**#10 (M5)**: SSE + webhook double-terminal causes LangGraph retry storm.~~ Fixed: `processEvent` is now state-aware; ignores all event kinds for terminated flows.
- ~~**#16**: Stale `hitl` after `graph:end` flips flow status `succeeded → waiting`.~~ Same fix as #10.
- ~~**#13**: Release tarball missing INSTALL.md / AUDIT / DESIGN / skills/.~~ Fixed in v0.11.2 tarball.

Still open at v0.12.0 — each will bite eventually if not avoided:

- **#7 (M2)**: Failed dispatches leave orphan "queued" flow records visible to `langgraph_inspect`. No data loss, but confuses inspect output.
- **#6 (M1)**: `decision_only` parameter has no effect. Don't rely on it; expect every milestone to fire a wake.
- **#11 (M6)**: `callbackToken` exposure path to LangGraph metadata — unverified. If LangGraph workflow authors are untrusted, audit before deploying with webhooks enabled.
- **#8 (M3)**: Dead code in `LanggraphClient.resumeRun()` has wrong wire format. Cosmetic until something revives it.
- **#9 (M4)**: Concurrent resume calls can open duplicate SSE streams. Low probability; user-triggerable only via rapid double-submit.
- **#15**: `typebox` (unscoped) vs `@sinclair/typebox` (scoped, canonical). Works; suggestion to swap on next refresh.

Track the full list at: https://github.com/ggettert/openclaw-langgraph-bridge/issues

---

## Operator's reference

- Plugin source: https://github.com/ggettert/openclaw-langgraph-bridge (canonical), mirrored at https://github.com/carpe/openclaw-langgraph-bridge
- Skill for agents using these tools: `skills/langgraph-bridge/SKILL.md` (ships inside the install)
- Audit: `AUDIT-2026-06-16.md` (ships inside the install) — adversarial review of v0.11.0
- Architecture: `DESIGN.md` (ships inside the install) — phase history
