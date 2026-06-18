/**
 * Phase 4 — Proactive Slack-thread wake via the `openclaw agent` CLI.
 *
 * Why: `requestHeartbeat` and `enqueueSystemEvent` do not wake a Slack-DM
 * session that runs the Anthropic provider directly (not the bundled PI
 * runtime). The empirically-confirmed primitive is the `openclaw agent`
 * CLI invoked from any out-of-process subscriber. Fleetmind's
 * `wakeAgent()` in src/cli/commands/nats.ts is the reference impl.
 *
 * Shape: fire-and-forget. The CLI opens a WebSocket to the gateway,
 * dispatches one agent turn, and exits. The agent's reply flows out
 * through whatever channel its session is bound to (Slack DM in our
 * case). We don't await the result — we just need the wake to land.
 *
 * Auth: the CLI resolves `process.env.OPENCLAW_GATEWAY_TOKEN /
 * OPENCLAW_GATEWAY_PASSWORD` first, then falls back to
 * `~/.openclaw/openclaw.json` gateway.auth.{token,password}. Since the
 * plugin runs inside the gateway (HOME=/home/openclaw), the CLI reads
 * the gateway auth from the config file automatically — no env-var
 * setup required. We still pass `process.env` through so any future
 * env override (and HOME) is preserved.
 *
 * Two-layer timeout trap (per fleetmind notes):
 *   - The CLI's own `--timeout` (default 600s) bounds how long the CLI
 *     waits for the gateway's final reply over the WebSocket.
 *   - execFile's `timeout` is the OUR-process backstop. If we kill the
 *     CLI mid-turn, the gateway aborts and surfaces a *misleading*
 *     "LLM request timed out" error to the user. So execFile must be
 *     strictly larger than the CLI timeout. Default: cli=600s,
 *     execFile=630s.
 */

import { execFile as execFileCb } from "node:child_process";

export type WakeAgentDeps = {
  /** Override the CLI binary (mainly for tests). Default: "openclaw". */
  bin?: string;
  /** Injected for tests. Default: node's execFile. */
  execFile?: typeof execFileCb;
  /** Optional env override. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Optional logger for failure surfacing. */
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
};

export type WakeAgentParams = {
  /** Agent id (e.g. "main"). Required. */
  agentId: string;
  /**
   * Explicit session key to route into, e.g. the originating Slack-thread
   * session key from the bound flow. Without this, the wake hits the
   * agent's `:main` session and is invisible to the live Slack thread.
   */
  sessionKey: string;
  /** Message body delivered as a system event to the agent. */
  message: string;
  /**
   * CLI `--timeout` in milliseconds. Default 600_000 (10 min).
   * Must accommodate the longest reasonable agent turn (the agent will
   * post to Slack, possibly call tools, write artifacts, etc.).
   */
  turnTimeoutMs?: number;
};

const DEFAULT_TURN_TIMEOUT_MS = 600_000;
const EXEC_BACKSTOP_PADDING_MS = 30_000;

/**
 * Fire a proactive agent turn. Returns a `Promise<void>` that resolves
 * when the subprocess exits (or rejects on error / timeout).
 *
 * The queue worker (`wake-queue.ts`) awaits this promise before pulling
 * the next job, which is how we enforce per-sessionKey FIFO ordering.
 *
 * Error behaviour: the promise rejects on subprocess error so the queue
 * can catch-and-continue. The error is also logged. The webhook handler
 * should still return 200 to LangGraph even if wake fails — errors here
 * must not propagate to the HTTP response path.
 */
export function wakeAgentAsync(
  params: WakeAgentParams,
  deps: WakeAgentDeps = {},
): Promise<void> {
  const bin = deps.bin ?? process.env.OPENCLAW_BIN ?? "openclaw";
  const execFile = deps.execFile ?? execFileCb;
  const env = deps.env ?? process.env;
  const turnTimeoutMs = params.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const logger = deps.logger;

  if (!params.agentId) {
    logger?.warn?.("langgraph-bridge: wakeAgentAsync skipped — no agentId");
    return Promise.resolve();
  }
  if (!params.sessionKey) {
    logger?.warn?.(
      "langgraph-bridge: wakeAgentAsync skipped — no sessionKey (would land on :main, invisible to Slack thread)",
    );
    return Promise.resolve();
  }
  if (!params.message) {
    logger?.warn?.("langgraph-bridge: wakeAgentAsync skipped — empty message");
    return Promise.resolve();
  }

  const args = [
    "agent",
    "--agent",
    params.agentId,
    "--session-key",
    params.sessionKey,
    "--message",
    params.message,
    "--timeout",
    // CLI takes seconds, not ms (per `openclaw agent --help`).
    String(Math.ceil(turnTimeoutMs / 1000)),
  ];

  logger?.info?.(
    `langgraph-bridge: wakeAgentAsync dispatched agent=${params.agentId} sessionKey=${params.sessionKey} msglen=${params.message.length}`,
  );

  return new Promise<void>((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: turnTimeoutMs + EXEC_BACKSTOP_PADDING_MS,
        env,
      },
      (err) => {
        if (err) {
          logger?.warn?.(
            `langgraph-bridge: wakeAgentAsync(${params.agentId}) subprocess failed: ${err.message}`,
          );
          reject(err);
        } else {
          logger?.info?.(
            `langgraph-bridge: wakeAgentAsync(${params.agentId}) completed`,
          );
          resolve();
        }
      },
    );
  });
}
