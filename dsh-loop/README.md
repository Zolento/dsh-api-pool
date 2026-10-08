---
description: "Repeat a prompt in the current DSH session on a fixed interval or an adaptive schedule."
kind: "plugin"
---

# dsh-loop

`/loop` repeats agent turns in the current session, using its conversation,
workspace, tools and permissions. Each iteration enters through `Agent.followup(...)`.

## Usage

```text
/loop 5m check whether the experiment has finished
/loop inspect CI and decide when to check again
/loop
```

- With an interval: fixed scheduling, with the first iteration due immediately.
- Without an interval: adaptive scheduling; each iteration calls
  `schedule_next_loop` or `stop_loop`. If it does neither, the loop pauses with
  “awaiting schedule”.
- Without a prompt: use `.dsh/loop.md` in the session working directory, or the
  default maintenance prompt if the file is absent, empty or unreadable.

Intervals use `<n>s`, `<n>m` or `<n>h`, with a default minimum of 30 seconds.
Zero, overflowing values and unsupported units such as `5min` are rejected.
Control words apply only to the
whole argument: `/loop stop the server if unhealthy` is a prompt.

| Command | Action |
|---|---|
| `/loop status` | Show phase, cadence, iteration count, next run and prompt |
| `/loop pause` | Pause scheduling and keep the configuration |
| `/loop resume` | Resume with the next iteration due immediately |
| `/loop stop` | End scheduling; let the current turn finish |

Pause and stop remove queued iterations that have not begun. Running turns
finish normally. Resuming during an iteration makes the next one due when the
Agent becomes idle.

## Model tools

```text
schedule_next_loop({ delay: "5m", reason: "training is still running" })
stop_loop({ reason: "training finished" })
```

`schedule_next_loop` is available in adaptive mode; `stop_loop` is available in
both modes. The tools are registered in the looping Agent's scope.

A schedule records a time without interrupting the current turn. The next
iteration waits until the Agent is idle and the delay has elapsed. Repeated
schedule calls in one iteration keep the last request.

Each session has one loop, one pending iteration and one next-run time. Missed
ticks coalesce into one iteration. A human interrupt moves the next fixed tick
a full interval ahead. Loops are process-local: restarting DSH or closing the
session clears them.

## Installation

```sh
dsh plugin --profile web add /path/to/dsh-loop
dsh --profile web --dump-config | grep -A2 '^# == dsh-loop'
```

Restart the profile after installation. The bundle adds one host row and makes
`/loop` available to its agents. Compatibility is recorded in
[`dsh-compat.json`](dsh-compat.json).

## Development

```sh
npm run link-dsh
npm test
npm run acceptance
```

Tests cover parsing, scheduling, races, registry integration and the production
AgentLoop. Acceptance checks profile composition and a real DSH boot using a
temporary `DSH_HOME` and a separate port.

The plugin config accepts `minIntervalMs` (default: `30000`) and `defaultPrompt`.

| Module | Responsibility |
|---|---|
| `src/service.js` | Loop state, timers and iteration accounting |
| `src/parser.js` | Command and duration parsing |
| `src/command.js` | `/loop` registration and status rendering |
| `src/tools.js` | Model scheduling and stop tools |
| `src/prompt.js` | Iteration messages and system guidance |
