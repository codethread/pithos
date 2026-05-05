export const tmuxNudgeCommands = (
  target: string,
  message: string,
): readonly [readonly string[], readonly string[]] => [
  ["tmux", "send-keys", "-t", target, "--", message],
  ["tmux", "send-keys", "-t", target, "Enter"],
]
