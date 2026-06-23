# Failure Modes — langgraph-bridge

Common failure patterns, root causes, fixes, and version context.

---

## KeyError on missing required input

**Symptom:** `langgraph_dispatch` returns `status: "accepted"`, milestone events fire briefly, then the workflow fails with a terminal event containing `KeyError: '<field_name>'`.

**Root cause:** `input` passed to dispatch didn't include a required key. LangGraph silently drops unknown keys and never validates the presence of required ones at dispatch — the schema mismatch only surfaces when a downstream node tries to read a key that was never set.

**Fix:**
1. Call `langgraph_inspect_workflow(workflow_id)` to learn the workflow's required input fields.
2. Reconstruct `input` with every field listed in `input_schema.required`.
3. Re-dispatch.

*Prevention:* always call `langgraph_inspect_workflow` before the first dispatch of any workflow in a session. See [discovering-workflows.md](./discovering-workflows.md).

---

## Stale plugin flow status after gateway restart

**Symptom:** `langgraph_inspect` shows `status: "running"` but no events are arriving and the LangGraph thread is actually at a HITL interrupt or already completed.

**Root cause:** Plugin managed TaskFlow state lives in process memory. A gateway restart wipes it. The plugin's view and LangGraph's view diverge. This was observed in practice: plugin reported `"running"`, LangGraph had the thread at a HITL interrupt with no active run.

**Fix:** Use the direct LangGraph API to check the thread's true state (see [escape-hatch.md](./escape-hatch.md)), then:
- If thread is `interrupted`: call `langgraph_resume` with the correct payload.
- If thread already `succeeded`/`failed`: take no further action; treat as terminal.

---

## Post-resume events not surfacing (pre-v0.10.0)

> **Fixed in v0.10.0+ (Phase 5).** Post-resume milestone and terminal events now surface correctly. This section is kept for context on older installs only.

**Symptom (pre-v0.10.0 only):** `langgraph_resume` returns `status: "resumed"` but the agent is never woken again, even though the workflow continued running and reached a terminal.

**Root cause:** Before Phase 5, `langgraph_resume` POSTed to `/threads/{tid}/runs` fire-and-forget. No SSE subscriber was opened on the new run, so events from the resumed graph never reached `processEvent` and never triggered a wake.

**Fix:** Upgrade to v0.10.0+. The `langgraph_resume` tool now routes through `dispatchAndStream` with `command: {resume: payload}`, opening an identical SSE subscriber to the initial dispatch.

---

## Post-resume frame replay / out-of-order events

**Symptom:** After a successful `langgraph_resume` (e.g. approving a gate), the session is woken by a flurry of trailing frames arriving *out of order* and *after* the work has actually completed: a **second HITL interrupt** (stale), followed by milestone recap frames — some landing *after* the `graph:end` terminal frame.

**Root cause:** The resumed run opens a fresh SSE subscriber (Phase 5, v0.10.0+), and the post-resume event stream can replay/buffer node frames rather than deliver them in strict causal order. The duplicate HITL frame is stale — the gate was already satisfied — but a consumer that reacts to frame *kind* alone could double-fire `langgraph_resume` into an already-completed flow.

**Fix (v0.11.2+):** The plugin now handles this server-side. `processEvent` checks flow status before any mutation; if the flow is already in a terminal state (`succeeded`, `failed`, `cancelled`, `lost`), the stale frame is dropped with action `ignored:post-terminal` — no `setWaiting` call, no wake, no double-fire risk. Closed by #10 (M5) and #16 in v0.11.2.

**Belt-and-suspenders guard for pre-v0.11.2 (still good practice regardless):**
1. **Call `langgraph_inspect` before `langgraph_resume`.** Treat `langgraph_inspect` as ground truth, not the raw frame. Any of these is terminal: `status: "succeeded"`, `"failed"`, `"cancelled"`, `"lost"`, or a `graph:end` summary in flow state. A trailing HITL frame after terminal is stale — do **not** call `langgraph_resume` again.
2. The `langgraph_resume` guard helps (it errors unless flow is `waiting`), but don't rely on it alone — confirm state with `langgraph_inspect` first.
3. Trailing recap milestones after terminal are informational replay; verify the real outcome out-of-band and don't re-post duplicates.

---

## LangGraph server unreachable

**Symptom:** `langgraph_dispatch` returns `status: "error"` with `ETIMEDOUT` or `connect ECONNREFUSED`. Or the call hangs until the 10 s client timeout.

**Root cause:** The LangGraph server is down, overloaded, or the route is blocked.

**Triage:**
- `ECONNREFUSED` → host is up but port is not listening. Check routing and confirm the port is open (`ss -tlnp | grep <port>` or `lsof -i :<port>`).
- `ETIMEDOUT` → host is unreachable. Check network path.

**Fix:** Restart the LangGraph server and retry.

---

## Wake reply lands at channel root, not in thread (pre-v0.11.0)

**Symptom:** When a workflow event fires and the plugin wakes the agent, the agent's reply appears at channel root instead of inside the originating thread.

**Root cause:** Pre-v0.11.0, wake messages contained no guidance on where to reply. The `openclaw agent` CLI had no `--thread-id` flag and the runtime didn't synthesize Slack reply context from the session key shape alone.

**Fix (v0.11.0+):** Wake messages for thread-bound sessions now include a `[reply-hint]` line at the top:

```
[reply-hint] This wake was bound to a Slack thread. Reply IN-THREAD by
passing threadId="<ts>" on your next message tool call (channel=<ch>).
Default outbound otherwise lands at channel root.
```

Extract the `threadId` and `channel` values from the hint and pass them in your outbound message tool call.
