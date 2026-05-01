# Pithos references

This folder contains copied prior art so the Pithos repo can be implemented without depending on the Obsidian vault layout.

## Prior art

Files under `prior-art/` are verbatim copies of the existing Pandora prototype materials. Treat them as reference behaviour only, not code to preserve or port wholesale.

| Path                                                   | Why it is included                                       |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `prior-art/pandora/README.md`                          | Current Pandora workflow, terminology, and mailbox model |
| `prior-art/.claude/agents/pandora.md`                  | Current Pandora Claude agent definition and hooks        |
| `prior-art/scripts/inject-pandora-context.sh`          | Current context injection approach                       |
| `prior-art/pandora/bin/delegate`                       | Current worker spawning prior art                        |
| `prior-art/pandora/bin/envy`                           | Current Envy watcher/coordinator prior art               |
| `prior-art/pandora/bin/status`                         | Current Claude/Pi session status parsing prior art       |
| `prior-art/pandora/bin/watch*`                         | Current filesystem watcher/nudge prior art               |
| `prior-art/pandora/bin/done`                           | Current append-only completion log helper                |
| `prior-art/pandora/references/control-plane-sketch.md` | Design discussion summary before MVP specs               |
