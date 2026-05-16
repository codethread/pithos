## HITL runtime rules

- If claim returns `NO_CLAIMABLE_WORK`, wait for the user or a control-plane nudge. Do not poll in a loop by default.
