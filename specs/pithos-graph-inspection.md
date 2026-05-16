# Pithos Graph Inspection

**Status:** Implemented; folded into [`task-graph.md`](./task-graph.md)
**Last Updated:** 2026-05-16

`pithos graph inspect` is implemented. The authoritative graph-inspection contract now lives in [`task-graph.md`](./task-graph.md), including:

- selectors: `--task`, `--scope`, and `--all`
- seed filters: repeatable `--status`, repeatable `--search`, and `--since`
- readable output semantics
- JSON graph closure semantics
- the boundary that `pithos briefing` owns agenda-style ready/blocked summaries

This file remains only as the historical record for the focused graph-inspection implementation slice. Do not restate the CLI or rendering contract here; update `task-graph.md` instead.
