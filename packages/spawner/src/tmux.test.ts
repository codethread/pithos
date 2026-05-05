import { expect, test } from "vitest"
import { tmuxNudgeCommands } from "./tmux.ts"

test("tmuxNudgeCommands sends the message literally then presses Enter", () => {
  expect(tmuxNudgeCommands("pithos-envy-12345678", "<system-reminder>you have mail!</system-reminder>")).toEqual([
    ["tmux", "send-keys", "-t", "pithos-envy-12345678", "-l", "--", "<system-reminder>you have mail!</system-reminder>"],
    ["tmux", "send-keys", "-t", "pithos-envy-12345678", "Enter"],
  ])
})

test("tmuxNudgeCommands preserves leading dashes in literal messages", () => {
  expect(tmuxNudgeCommands("pithos-envy-12345678", "--follow-up")[0]).toEqual([
    "tmux",
    "send-keys",
    "-t",
    "pithos-envy-12345678",
    "-l",
    "--",
    "--follow-up",
  ])
})
