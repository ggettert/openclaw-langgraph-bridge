# Event Labels & Kinds

How the bridge classifies inbound workflow events and what each label means for the agent. This is the general contract — no workflow-specific vocabulary. For the full webhook payload schema see [`docs/workflow-contract.md`](../../../docs/workflow-contract.md); for the `emit_phase_event` helper see [`docs/phase-event-contract.md`](../../../docs/phase-event-contract.md).

---

## Two labels per event

Every event the workflow emits carries two independent labels:

- **`kind`** — the *semantic class*. Drives whether the agent wakes and how. One of five values (below). The workflow author sets it; the plugin enforces what it means (`src/event-classifier.ts`).
- **`title`** — a short *machine-readable name*, e.g. `"coder:started"` / `"coder:finished"`. Shown in the wake-message header and used as the dedup key. Convention: `<phase>:<action>`. The reader matches on `title` to know *which* step fired; `kind` tells it *how loud* to be.

`title` is the "SSE label" surfaced to the human. `kind` is the routing control. Do not conflate them: a `coder:finished` title can be `kind: "milestone"` (wakes) or `kind: "status"` (silent) depending on what the author wants.

---

## The five kinds

| `kind` | Wakes agent? | Plugin action | Use for |
|---|---|---|---|
| `status` | No | flow state updated only; deduped as noise | high-rate progress noise (`:started` acks, heartbeats) |
| `milestone` | Light | brief note posted | meaningful step completion (PR opened, verdict reached) |
| `decision` | Yes | agent woken to decide what to say/do | branch points the agent should react to |
| `terminal` | Yes | flow finished + final-summary wake | run success/failure |
| `hitl` | Yes | flow set to `waiting` + wake to ask | human approval gate at an interrupt |

Invalid `kind` values return HTTP 400 at the webhook.

---

## `decision_only` interaction

`langgraph_dispatch(decision_only=…)` gates the wake layer on top of `kind`:

- `decision_only: true` (default) — only `decision` / `hitl` / `terminal` wake. `milestone` updates flow state silently; `status` never wakes.
- `decision_only: false` — `milestone` also wakes (light note). `status` still never wakes.

So `status` is always silent; `decision`/`hitl`/`terminal` always wake; `milestone` is the only kind whose wake behavior `decision_only` toggles.

---

## Reader-side pattern

1. On wake, read `event.title` to identify the step and action (`<phase>:started` vs `<phase>:finished`).
2. Post one short line per event: `<emoji> <title> — <summary>`.
3. `:started`-style titles (usually `kind: status`) need at most a one-line ack; `:finished`/milestone titles carry the outcome detail.
4. `hitl` → surface the prompt, wait for the human, then `langgraph_resume`. Never resume unprompted.

## Author-side guidance (avoiding wake-storms)

Set `kind` explicitly on every emission. If you rely on the bridge's coarse fallback (classify by action name alone), *both* `started` and `finished` become `milestone` and every `:started` wakes — a parallel-phase run then wake-storms. Mark `:started` frames `kind: "status"` (silent) and only outcome-bearing `:finished` frames `kind: "milestone"`. The `emit_phase_event` helper derives sensible `kind`/`title` for you.
