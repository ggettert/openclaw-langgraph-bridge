"""
Minimal no-op LangGraph stub for integration testing.

This graph registers the 'integration-stub' assistant so that
openclaw-langgraph-bridge integration tests can exercise real HTTP
paths (createThread, createRun, dispatchAndStream) without requiring
a full application graph.

The graph accepts any input and returns an empty state update immediately.
"""

from typing import Any
from langgraph.graph import StateGraph


def _passthrough(state: dict[str, Any]) -> dict[str, Any]:
    """Single node: accept any state, return no updates."""
    return {}


# Build the graph -------------------------------------------------------
builder = StateGraph(dict)
builder.add_node("passthrough", _passthrough)
builder.set_entry_point("passthrough")
builder.set_finish_point("passthrough")

graph = builder.compile()
