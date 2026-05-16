## Repo-scope default-branch guard (run before claiming any task)

If `scope_id` starts with `repo:` **and the cwd is a git repository**, verify the canonical repo root is on its remote default branch before doing any work. Worktree scopes and non-git repo scopes are exempt.

```sh
if [[ "$PITHOS_SCOPE_ID" == repo:* ]]; then
  _repo_root="$PWD"
  if git -C "$_repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    _default_branch=$(
      git -C "$_repo_root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##'
    )
    if [[ -z "$_default_branch" ]]; then
      _default_branch=$(
        git -C "$_repo_root" remote show origin 2>/dev/null | awk -F': ' '/HEAD branch/ {print $2; exit}'
      )
    fi
    _current_branch=$(git -C "$_repo_root" branch --show-current)
    if [[ -z "$_default_branch" ]]; then
      pithos task enqueue --run "$PITHOS_RUN_ID" --scope global --capability escalate \
        --title 'Could not detect default branch for repo-scope guard' --stdin <<'EOF_ESC'
Startup guard could not determine the default branch and stopped before claiming work.

Please verify the repo has a remote named `origin` with HEAD configured, then re-run the agent.
EOF_ESC
      exit 0
    fi
    if [[ "$_current_branch" != "$_default_branch" ]]; then
      pithos task enqueue --run "$PITHOS_RUN_ID" --scope global --capability escalate \
        --title 'Repo root not on default branch — startup guard stopped' --stdin <<EOF_ESC
Startup guard stopped before claiming work because the canonical repo root is not on its default branch.

Repo path: $_repo_root
Current branch: $_current_branch
Expected default branch: $_default_branch
Scope: $PITHOS_SCOPE_ID
Run: $PITHOS_RUN_ID

Switch the repo to $_default_branch before re-running this agent.
EOF_ESC
      exit 0
    fi
  fi
fi
```
