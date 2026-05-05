export const tmuxNudgeCommands = (
  target: string,
  message: string,
): readonly [readonly string[], readonly string[]] => [
  ["tmux", "send-keys", "-t", target, "-l", "--", message],
  ["tmux", "send-keys", "-t", target, "Enter"],
]
