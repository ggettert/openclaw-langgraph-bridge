import { describe, expect, it, vi } from "vitest";
import { wakeAgentAsync } from "./wake-agent.js";

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv },
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => unknown;

function makeExecFile() {
  const calls: Array<{
    file: string;
    args: readonly string[];
    options: { timeout?: number; env?: NodeJS.ProcessEnv };
  }> = [];
  const fn: ExecFileLike = (file, args, options, cb) => {
    calls.push({ file, args, options });
    // simulate async success
    queueMicrotask(() => cb(null, "", ""));
    return undefined;
  };
  return { fn, calls };
}

function makeLogger() {
  return {
    info: vi.fn<(msg: string) => void>(),
    warn: vi.fn<(msg: string) => void>(),
    error: vi.fn<(msg: string) => void>(),
  };
}

describe("wakeAgentAsync", () => {
  it("dispatches `openclaw agent` with required flags and returns a Promise", async () => {
    const { fn, calls } = makeExecFile();
    const logger = makeLogger();
    const result = wakeAgentAsync(
      {
        agentId: "main",
        sessionKey: "agent:main:slack:direct:u123",
        message: "hello",
      },
      { execFile: fn as never, logger },
    );
    // Must return a Promise
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("openclaw");
    expect(calls[0]!.args).toEqual([
      "agent",
      "--agent",
      "main",
      "--session-key",
      "agent:main:slack:direct:u123",
      "--message",
      "hello",
      "--timeout",
      "600", // 600_000ms / 1000
    ]);
  });

  it("execFile timeout is strictly larger than --timeout to avoid mid-turn SIGTERM", async () => {
    const { fn, calls } = makeExecFile();
    await wakeAgentAsync(
      {
        agentId: "main",
        sessionKey: "k",
        message: "m",
        turnTimeoutMs: 120_000,
      },
      { execFile: fn as never },
    );
    expect(calls[0]!.options.timeout).toBe(150_000);
    // CLI seconds = 120
    expect(calls[0]!.args).toContain("120");
  });

  it("respects OPENCLAW_BIN override", async () => {
    const { fn, calls } = makeExecFile();
    await wakeAgentAsync(
      { agentId: "a", sessionKey: "s", message: "m" },
      { execFile: fn as never, bin: "/custom/openclaw" },
    );
    expect(calls[0]!.file).toBe("/custom/openclaw");
  });

  it("skips with warning and resolves immediately when agentId is missing", async () => {
    const { fn, calls } = makeExecFile();
    const logger = makeLogger();
    await wakeAgentAsync(
      { agentId: "", sessionKey: "s", message: "m" },
      { execFile: fn as never, logger },
    );
    expect(calls).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("skips with warning and resolves immediately when sessionKey is missing", async () => {
    const { fn, calls } = makeExecFile();
    const logger = makeLogger();
    await wakeAgentAsync(
      { agentId: "a", sessionKey: "", message: "m" },
      { execFile: fn as never, logger },
    );
    expect(calls).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("rejects when subprocess fails — logs warn and rejects with the error", async () => {
    const errFn: ExecFileLike = (_f, _a, _o, cb) => {
      queueMicrotask(() => cb(new Error("boom"), "", ""));
      return undefined;
    };
    const logger = makeLogger();
    await expect(
      wakeAgentAsync(
        { agentId: "a", sessionKey: "s", message: "m" },
        { execFile: errFn as never, logger },
      ),
    ).rejects.toThrow("boom");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("resolves (not rejects) on subprocess success", async () => {
    const { fn } = makeExecFile();
    const logger = makeLogger();
    await expect(
      wakeAgentAsync(
        { agentId: "a", sessionKey: "s", message: "m" },
        { execFile: fn as never, logger },
      ),
    ).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalled();
  });

  describe("--model override (milestone_model dispatch param)", () => {
    it("appends `--model <value>` when params.model is set", async () => {
      const { fn, calls } = makeExecFile();
      const logger = makeLogger();
      await wakeAgentAsync(
        {
          agentId: "main",
          sessionKey: "agent:main:slack:direct:u123",
          message: "hello",
          model: "anthropic/claude-sonnet-4-6",
        },
        { execFile: fn as never, logger },
      );
      expect(calls).toHaveLength(1);
      const args = calls[0]!.args;
      const modelIdx = args.indexOf("--model");
      expect(modelIdx).toBeGreaterThan(-1);
      expect(args[modelIdx + 1]).toBe("anthropic/claude-sonnet-4-6");
    });

    it("does NOT append `--model` when params.model is undefined", async () => {
      const { fn, calls } = makeExecFile();
      await wakeAgentAsync(
        { agentId: "main", sessionKey: "agent:main:slack:direct:u", message: "hi" },
        { execFile: fn as never },
      );
      expect(calls[0]!.args).not.toContain("--model");
    });

    it("does NOT append `--model` when params.model is an empty / whitespace string", async () => {
      const { fn, calls } = makeExecFile();
      await wakeAgentAsync(
        {
          agentId: "main",
          sessionKey: "agent:main:slack:direct:u",
          message: "hi",
          model: "   ",
        },
        { execFile: fn as never },
      );
      expect(calls[0]!.args).not.toContain("--model");
    });

    it("on `Model override ... is not allowed for agent` rejection, retries WITHOUT --model and resolves", async () => {
      const calls: Array<{ file: string; args: readonly string[] }> = [];
      // First call: simulate gateway rejection with the verified stderr.
      // Second call (retry without --model): success.
      const fn: ExecFileLike = (file, args, _options, cb) => {
        calls.push({ file, args });
        if (calls.length === 1) {
          const stderr =
            'GatewayClientRequestError: Error: Model override "not-a-real-model/nope" is not allowed for agent "main".';
          queueMicrotask(() => cb(new Error(stderr), "", stderr));
        } else {
          queueMicrotask(() => cb(null, "", ""));
        }
        return undefined;
      };
      const logger = makeLogger();
      const onInvalidModel = vi.fn<(p: { model: string; cliError: string }) => void>();

      await expect(
        wakeAgentAsync(
          {
            agentId: "main",
            sessionKey: "s",
            message: "m",
            model: "not-a-real-model/nope",
          },
          { execFile: fn as never, logger, onInvalidModel },
        ),
      ).resolves.toBeUndefined();

      expect(calls).toHaveLength(2);
      // First call: had --model
      expect(calls[0]!.args).toContain("--model");
      expect(calls[0]!.args).toContain("not-a-real-model/nope");
      // Retry: no --model
      expect(calls[1]!.args).not.toContain("--model");
      // onInvalidModel was called before the retry
      expect(onInvalidModel).toHaveBeenCalledOnce();
      expect(onInvalidModel).toHaveBeenCalledWith(
        expect.objectContaining({ model: "not-a-real-model/nope" }),
      );
      // Logged a warn about the rejection
      expect(logger.warn).toHaveBeenCalled();
    });

    it("if retry without --model also fails, rejects with the retry's error", async () => {
      const calls: Array<{ args: readonly string[] }> = [];
      const fn: ExecFileLike = (_file, args, _options, cb) => {
        calls.push({ args });
        if (calls.length === 1) {
          const stderr = 'Error: Model override "bad" is not allowed for agent "main".';
          queueMicrotask(() => cb(new Error(stderr), "", stderr));
        } else {
          queueMicrotask(() => cb(new Error("second failure"), "", ""));
        }
        return undefined;
      };
      await expect(
        wakeAgentAsync(
          { agentId: "main", sessionKey: "s", message: "m", model: "bad" },
          { execFile: fn as never, logger: makeLogger() },
        ),
      ).rejects.toThrow("second failure");
      expect(calls).toHaveLength(2);
    });

    it("on UNRELATED subprocess failure (no invalid-model marker), does NOT retry and propagates", async () => {
      const calls: Array<{ args: readonly string[] }> = [];
      const fn: ExecFileLike = (_file, args, _options, cb) => {
        calls.push({ args });
        // Generic failure that does NOT contain the invalid-model marker.
        queueMicrotask(() => cb(new Error("connection refused"), "", "connection refused"));
        return undefined;
      };
      const logger = makeLogger();
      const onInvalidModel = vi.fn();
      await expect(
        wakeAgentAsync(
          { agentId: "main", sessionKey: "s", message: "m", model: "sonnet" },
          { execFile: fn as never, logger, onInvalidModel },
        ),
      ).rejects.toThrow("connection refused");
      expect(calls).toHaveLength(1); // no retry
      expect(onInvalidModel).not.toHaveBeenCalled();
    });

    it("does NOT trigger invalid-model retry when no model was set in the first place", async () => {
      const calls: Array<{ args: readonly string[] }> = [];
      const fn: ExecFileLike = (_file, args, _options, cb) => {
        calls.push({ args });
        // Even if the error LOOKS like the invalid-model pattern (defensive),
        // we must not retry when no model was set — there's nothing to drop.
        queueMicrotask(() =>
          cb(
            new Error('Model override "x" is not allowed for agent "main".'),
            "",
            'Model override "x" is not allowed for agent "main".',
          ),
        );
        return undefined;
      };
      const onInvalidModel = vi.fn();
      await expect(
        wakeAgentAsync(
          { agentId: "main", sessionKey: "s", message: "m" }, // no model
          { execFile: fn as never, logger: makeLogger(), onInvalidModel },
        ),
      ).rejects.toThrow("Model override");
      expect(calls).toHaveLength(1);
      expect(onInvalidModel).not.toHaveBeenCalled();
    });

    it("whitespace-only model: no `--model` in args, no retry on invalid-model-shaped failure, no onInvalidModel call", async () => {
      // Regression test for the bug Copilot caught: a whitespace-only
      // `params.model` was passing the `!!params.model` truthy check,
      // which would have (a) tripped the invalid-model retry on any
      // error matching the pattern, and (b) invoked onInvalidModel
      // with the untrimmed whitespace string. Fix: normalize once into
      // `modelArg` (trimmed, or undefined when empty); use it as the
      // single source of truth for arg emission, logging, retry-gating,
      // and the onInvalidModel callback.
      const calls: Array<{ args: readonly string[] }> = [];
      const fn: ExecFileLike = (_file, args, _options, cb) => {
        calls.push({ args });
        queueMicrotask(() =>
          cb(
            new Error('Model override "x" is not allowed for agent "main".'),
            "",
            'Model override "x" is not allowed for agent "main".',
          ),
        );
        return undefined;
      };
      const onInvalidModel = vi.fn();
      const logger = makeLogger();
      await expect(
        wakeAgentAsync(
          { agentId: "main", sessionKey: "s", message: "m", model: "   " },
          { execFile: fn as never, logger, onInvalidModel },
        ),
      ).rejects.toThrow("Model override");
      // First (and only) call must not contain --model.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).not.toContain("--model");
      // onInvalidModel must NOT fire — we didn't actually send a model.
      expect(onInvalidModel).not.toHaveBeenCalled();
      // The dispatch log line must NOT include `model=` for whitespace-only.
      const dispatchLog = logger.info.mock.calls.find((c) =>
        c[0].includes("wakeAgentAsync dispatched"),
      );
      expect(dispatchLog).toBeDefined();
      expect(dispatchLog![0]).not.toMatch(/model=/);
    });

    it("trims leading/trailing whitespace before forwarding to the CLI", async () => {
      const { fn, calls } = makeExecFile();
      await wakeAgentAsync(
        {
          agentId: "main",
          sessionKey: "s",
          message: "m",
          model: "  anthropic/claude-sonnet-4-6  ",
        },
        { execFile: fn as never },
      );
      const args = calls[0]!.args;
      const modelIdx = args.indexOf("--model");
      expect(modelIdx).toBeGreaterThan(-1);
      // Trimmed value forwarded to CLI — no whitespace.
      expect(args[modelIdx + 1]).toBe("anthropic/claude-sonnet-4-6");
    });
  });
});
