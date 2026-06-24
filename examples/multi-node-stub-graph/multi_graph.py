"""
Minimal parallel-branch stub graph for openclaw-langgraph-bridge integration testing.

Fans out from a single node to two parallel branches, then joins. The purpose
is to observe what the bridge emits when LangGraph reports multiple node deltas
in a single updates SSE frame (fan-out / fan-in pattern).

Graph shape:
    START → fanout → branch_a ─┐
                  └→ branch_b ─┤→ joinup → END
"""

from typing import TypedDict, Annotated
from operator import add

from langgraph.graph import StateGraph, START, END


class State(TypedDict, total=False):
    branches: Annotated[list[str], add]
    final: str


def fanout(state: State) -> dict:
    """No-op: just triggers the parallel edges to branch_a and branch_b."""
    return {}


def branch_a(state: State) -> dict:
    return {"branches": ["a"]}


def branch_b(state: State) -> dict:
    return {"branches": ["b"]}


def joinup(state: State) -> dict:
    collected = sorted(state.get("branches", []))
    return {"final": f"joined:{','.join(collected)}"}


builder = StateGraph(State)
builder.add_node("fanout", fanout)
builder.add_node("branch_a", branch_a)
builder.add_node("branch_b", branch_b)
builder.add_node("joinup", joinup)
builder.add_edge(START, "fanout")
builder.add_edge("fanout", "branch_a")
builder.add_edge("fanout", "branch_b")
builder.add_edge("branch_a", "joinup")
builder.add_edge("branch_b", "joinup")
builder.add_edge("joinup", END)

graph = builder.compile()
