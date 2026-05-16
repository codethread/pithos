# Task 6: Template guard renderability

## Scope

Type: AFK

Make every bundled Agent template render again before changing command-card behavior. Preserve fail-loud template rendering while resolving the missing guard placeholders used by Toil, Greed, and War.

## Must implement exactly

- Resolve the missing `{{shared/repo-default-branch-guard.md}}` and `{{war/cwd-guard.md}}` placeholders by adding real bundled include files and listing each exact path in the affected `agents.json` manifest entries.
- Keep include names identical to the placeholders already used in the templates; includes are keyed by exact manifest string.
- Keep guard text concise and role-safe:
  - the shared repo-default-branch guard must prevent Toil/Greed from doing direct implementation edits on a repo default branch and steer implementation to worktree-scoped execution or escalation;
  - the War cwd guard must require War to verify it is operating in the intended cwd/scope before modifying files and to fail or escalate on mismatch.
- Do not make guard includes optional and do not add silent fallbacks for missing template variables.
- Add or update render/preview coverage so bundled templates render for every built-in Agent kind.

## Done when

- `renderAgent` or `pandora-spawn preview` can render Pandora, Toil, Greed, War, and Envy using bundled templates without unknown-template-variable failures.
- The new guard includes appear only for the agents that reference them.
- Existing overlay/include fail-loud behavior is preserved.
- Relevant Spawner tests pass.

## Out of scope

- Changing `{{command_cards}}` output.
- Changing agent claim/enqueue authorization.
- Adding new Agent kinds or Capabilities.
- Broad prompt rewrites beyond the missing guard includes.

## References

- `specs/agent-command-reference.md`
- `templates/agents.json`
- `templates/toil.md`
- `templates/greed.md`
- `templates/war.md`
- `templates/README.md`
- `packages/spawner/src/spawner.ts`
- `packages/spawner/src/spawner.test.ts`
