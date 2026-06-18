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
});
