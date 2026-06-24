"""
Minimal HITL stub graph for openclaw-langgraph-bridge integration testing.

Single interrupt node: pauses for a human decision, then routes based on
the resume payload to a terminal "done" node. Exercises the full dispatch
→ __interrupt__ → resume → terminal lifecycle the bridge plugin handles.
"""

from typing import TypedDict

from langgraph.graph import StateGraph, START, END
from langgraph.types import interrupt


class State(TypedDict, total=False):
    decision: str
    feedback: str
    final: str


def gate(state: State) -> State:
    """Pause for human decision."""
    payload = interrupt({"prompt": "approve or block_revise?"})
    # payload may be a plain string OR the normalized {decision, feedback} shape.
    if isinstance(payload, dict):
        decision = payload.get("decision", "")
        feedback = payload.get("feedback", "")
    else:
        decision = str(payload)
        feedback = ""
    return {"decision": decision, "feedback": feedback}


def done(state: State) -> State:
    decision = state.get("decision", "unknown")
    feedback = state.get("feedback", "")
    if feedback:
        return {"final": f"completed:{decision}:{feedback}"}
    return {"final": f"completed:{decision}"}


builder = StateGraph(State)
builder.add_node("gate", gate)
builder.add_node("done", done)
builder.add_edge(START, "gate")
builder.add_edge("gate", "done")
builder.add_edge("done", END)

graph = builder.compile()
