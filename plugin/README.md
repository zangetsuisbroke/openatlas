# opencode-atlas

Atlas knowledge graph plugin for [OpenCode](https://opencode.ai). Exposes your live workspace graph as native tools — no MCP config needed.

## What it does

Registers 4 tools in OpenCode:

| Tool | Description |
|------|-------------|
| `atlas_graph_search` | Find nodes by label/id (files, folders, packages, concepts) |
| `atlas_graph_query` | Get subgraph around a node (neighbors, relationships) |
| `atlas_graph_snapshot` | Summary of the entire workspace graph |
| `atlas_graph_path` | Shortest path between two nodes |

Plus a bundled skill that teaches the agent when and how to use them.

## Install

```bash
npm install -g opencode-atlas
```

## Setup

1. Start Atlas (desktop app or standalone server):
   ```
   atlas-workspace.exe
   ```
   Server runs on `http://localhost:4819` by default.

2. Add the plugin to your OpenCode config (`opencode.json`):
   ```json
   {
     "plugins": [
       {
         "package": "opencode-atlas",
         "options": { "port": 4819 }
       }
     ]
   }
   ```

3. Restart OpenCode. The `atlas_graph_*` tools are now available.

## Usage

The agent will automatically use the tools when it needs project context:

- "Which files import this module?" → `atlas_graph_query`
- "What's in this project?" → `atlas_graph_snapshot`
- "How is X connected to Y?" → `atlas_graph_path`
- "Find the node for a file" → `atlas_graph_search`

## Requirements

- Atlas server running (desktop app or `atlas-workspace.exe`)
- OpenCode with plugin support

## License

MIT
