import { describe, expect, it } from "vitest";
import { classifyStreamEvent } from "./event-subscriber.js";

describe("classifyStreamEvent", () => {
  it("error event becomes terminal", () => {
    const body = classifyStreamEvent(
      { event: "error", data: { error: "KeyError", message: "'ticket_id'" } },
      "flow-1",
      0,
    );
    expect(body).not.toBeNull();
    expect(body!.kind).toBe("terminal");
    expect(body!.title).toContain("error: KeyError");
    expect(body!.summary).toBe("'ticket_id'");
  });

  it("interrupt event becomes hitl", () => {
    const body = classifyStreamEvent(
      {
        event: "interrupt",
        data: { interrupt_id: "i-42", prompt: "approve?" },
        metadata: { langgraph_node: "approval_gate" },
      },
      "flow-1",
      0,
    );
    expect(body).not.toBeNull();
    expect(body!.kind).toBe("hitl");
    expect(body!.interrupt_id).toBe("i-42");
    expect(body!.title).toContain("approval_gate");
  });

  it("on_chain_start on the root graph is skipped (no node)", () => {
    const body = classifyStreamEvent(
      {
        event: "on_chain_start",
        name: "fleet",
        metadata: {},
      },
      "flow-1",
      0,
    );
    expect(body).toBeNull();
  });

  it("on_chain_start on a sub-node becomes milestone", () => {
    const body = classifyStreamEvent(
      {
        event: "on_chain_start",
        name: "coder",
        metadata: { langgraph_node: "coder", langgraph_step: 3 },
      },
      "flow-1",
      5,
    );
    expect(body).not.toBeNull();
    expect(body!.kind).toBe("milestone");
    expect(body!.title).toBe("node:coder:start");
    expect(body!.summary).toContain("3");
    expect(body!.seq).toBe(5);
  });

  it("on_chain_end on the root graph becomes terminal (success)", () => {
    const body = classifyStreamEvent(
      { event: "on_chain_end", name: "fleet", metadata: {}, data: { output: "ok" } },
      "flow-1",
      99,
    );
    expect(body).not.toBeNull();
    expect(body!.kind).toBe("terminal");
    expect(body!.title).toBe("graph:end");
  });

  it("on_chain_end on a sub-node becomes status", () => {
    const body = classifyStreamEvent(
      {
        event: "on_chain_end",
        name: "coder",
        metadata: { langgraph_node: "coder", langgraph_step: 3 },
      },
      "flow-1",
      6,
    );
    expect(body).not.toBeNull();
    expect(body!.kind).toBe("status");
    expect(body!.title).toBe("node:coder:end");
  });

  it("on_tool_* becomes status", () => {
    const body = classifyStreamEvent(
      { event: "on_tool_start", name: "shell" },
      "flow-1",
      0,
    );
    expect(body).not.toBeNull();
    expect(body!.kind).toBe("status");
    expect(body!.title).toContain("on_tool_start");
  });

  it("unrelated events return null (model_start etc.)", () => {
    expect(
      classifyStreamEvent({ event: "on_chat_model_start" }, "flow-1", 0),
    ).toBeNull();
    expect(classifyStreamEvent({ event: "metadata" }, "flow-1", 0)).toBeNull();
  });

  it("flow_id is propagated", () => {
    const body = classifyStreamEvent(
      {
        event: "on_chain_start",
        metadata: { langgraph_node: "coder" },
      },
      "my-flow-99",
      0,
    );
    expect(body!.flow_id).toBe("my-flow-99");
  });
});
