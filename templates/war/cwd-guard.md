## CWD guard (run before claiming or doing any work)

```sh
wktree root --cwd "$PWD"
```

- If output **equals** `$PWD`: you are at a canonical repo root, not inside a worktree. A worktree should have been allocated before launching War. Enqueue a global escalation explaining the situation, then fail the held task with the reason `cwd is a repo root, not a worktree`.
- If output **differs** from `$PWD`: you are inside a worktree. Proceed normally.
