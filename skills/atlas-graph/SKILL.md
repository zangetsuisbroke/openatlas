---
name: atlas-graph
description: Access the live Atlas knowledge graph to explore workspace structure, file relationships, dependencies, and track decisions, tasks, memories, and errors.
---

# Atlas Graph

## What I do
- Expose the live Atlas knowledge graph: real files, folders, packages, imports, git branch, tools, concepts, decisions, tasks, memories and errors that have been observed.
- The graph is maintained live: workspace scans plus every command run in the terminal.
- **Write to the graph** to track work as it happens — decisions, tasks, memories, errors.

## MANDATORY RULES

**You MUST:**
1. **ALWAYS** call `atlas_graph_add_node` with type `decision` when you make or explain a design choice
2. **ALWAYS** call `atlas_graph_log_error` when you encounter or fix an error
3. **ALWAYS** call `atlas_graph_add_node` with type `task` when you identify work that needs to be done
4. **ALWAYS** call `atlas_graph_add_node` with type `memory` when you learn something important about the project
5. **ALWAYS** call `atlas_graph_add_link` to connect related entities

**Do NOT skip tracking because:**
- "It's obvious" — It's not obvious to future agents
- "It's temporary" — Temporary things still need tracking
- "The user didn't ask" — You should track proactively
- "It's too minor" — Minor things add up

## When to use me

### Reading
- "which files import this module?" — use `atlas_graph_query` on the file node
- "what exists in this project?" — use `atlas_graph_snapshot` or `atlas_graph_search`
- "how is X related to Y?" — use `atlas_graph_path`
- "find the node for a file/package/tool" — use `atlas_graph_search`

### Writing (MANDATORY)
- You make a decision — `atlas_graph_add_node` with type `decision` **IMMEDIATELY**
- You encounter an error — `atlas_graph_log_error` **IMMEDIATELY**
- You identify a task — `atlas_graph_add_node` with type `task` **IMMEDIATELY**
- You learn something — `atlas_graph_add_node` with type `memory` **IMMEDIATELY**
- Two things are related — `atlas_graph_add_link` **IMMEDIATELY**

## How to use
1. Start with `atlas_graph_search` (or `atlas_graph_snapshot`) to locate node ids.
2. Expand with `atlas_graph_query <node> depth=1..2` to see relationships.
3. Use `atlas_graph_path` to trace indirect connections between two entities.
4. **Track EVERYTHING as you go** — decisions, errors, tasks, memories — the graph is your notebook.
Keep limits modest (search <= 20, query depth 1-2) to stay token-efficient.
