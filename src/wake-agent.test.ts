import { describe, expect, it, vi } from "vitest";
import { wakeAgent } from "./wake-agent.js";

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

describe("wakeAgent", () => {
  it("dispatches `openclaw agent` with required flags", () => {
    const { fn, calls } = makeExecFile();
    const logger = makeLogger();
    wakeAgent(
      {
        agentId: "main",
        sessionKey: "agent:main:slack:direct:u123",
        message: "hello",
      },
      { execFile: fn as never, logger },
    );
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

  it("execFile timeout is strictly larger than --timeout to avoid mid-turn SIGTERM", () => {
    const { fn, calls } = makeExecFile();
    wakeAgent(
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

  it("respects OPENCLAW_BIN override", () => {
    const { fn, calls } = makeExecFile();
    wakeAgent(
      { agentId: "a", sessionKey: "s", message: "m" },
      { execFile: fn as never, bin: "/custom/openclaw" },
    );
    expect(calls[0]!.file).toBe("/custom/openclaw");
  });

  it("skips with warning when agentId is missing", () => {
    const { fn, calls } = makeExecFile();
    const logger = makeLogger();
    wakeAgent(
      { agentId: "", sessionKey: "s", message: "m" },
      { execFile: fn as never, logger },
    );
    expect(calls).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("skips with warning when sessionKey is missing", () => {
    const { fn, calls } = makeExecFile();
    const logger = makeLogger();
    wakeAgent(
      { agentId: "a", sessionKey: "", message: "m" },
      { execFile: fn as never, logger },
    );
    expect(calls).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("does not throw if execFile subprocess fails — logs warn", async () => {
    const errFn: ExecFileLike = (_f, _a, _o, cb) => {
      queueMicrotask(() => cb(new Error("boom"), "", ""));
      return undefined;
    };
    const logger = makeLogger();
    expect(() =>
      wakeAgent(
        { agentId: "a", sessionKey: "s", message: "m" },
        { execFile: errFn as never, logger },
      ),
    ).not.toThrow();
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(logger.warn).toHaveBeenCalled();
  });
});
