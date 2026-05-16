# Pithos Graph Inspection

**Status:** Deprecated
**Last Updated:** 2026-05-16

`pithos graph inspect` is implemented, and this focused implementation slice has been folded into [`task-graph.md`](./task-graph.md). The authoritative graph-inspection contract now lives there, including:

- selectors: `--task`, `--scope`, and `--all`
- seed filters: repeatable `--status`, repeatable `--search`, and `--since`
- readable output semantics
- JSON graph closure semantics
- the boundary that `pithos briefing` owns agenda-style ready/blocked summaries

This file remains only as the historical record for the focused graph-inspection implementation slice. Do not restate the CLI or rendering contract here; update `task-graph.md` instead.
