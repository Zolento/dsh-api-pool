---
description: "A Claude-Code-style /loop for DeepSeek Harness: repeat a prompt in the current session on a fixed interval or an adaptive schedule."
kind: "plugin"
---

# dsh-loop

`/loop` repeats an ordinary agent turn in the **current session** — the same
conversation, the same workspace, the same tools and permissions as any other
turn. A fixed loop runs on a wall-clock interval; an adaptive loop lets each
iteration decide when the next one should run, or stop.

It is a plugin over public seams: iterations enter through `Agent.followup(...)`,
so nothing in `@deepseek-ai/dsh-agent-loop` is modified or bypassed.

## Usage

```
/loop 5m check whether the experiment has finished
```
Fixed loop: one iteration every 5 minutes, starting immediately.

```
/loop inspect CI and decide when to check again
```
Adaptive loop: no interval. Each iteration must call `schedule_next_loop` with a
delay, or `stop_loop`, before it finishes.

```
/loop
```
Uses `.dsh/loop.md` from the session working directory when it exists and is
non-empty; otherwise it uses a short default autonomous maintenance prompt.

```
/loop status          # phase, cadence, iteration count, next run, prompt
/loop pause           # keep the configuration, schedule nothing
/loop resume          # re-arm; the next iteration is due immediately
/loop stop            # clear the timer and end the loop for good
```

Intervals are strict: `<n>s`, `<n>m`, `<n>h` (`30s`, `5m`, `1h`). The floor is
30s. `5x`, `5min` and `10s` are rejected rather than reinterpreted. Control words
count only when they are the whole argument, so
`/loop stop the server if unhealthy` is a prompt.

## Fixed versus adaptive

| | `/loop 5m <prompt>` | `/loop <prompt>` |
|---|---|---|
| Next run decided by | the interval | the model, per iteration |
| Model surface | `stop_loop` | `schedule_next_loop`, `stop_loop` |
| If an iteration ends without a decision | next tick is already scheduled | the loop pauses and says "awaiting schedule" |

`schedule_next_loop({ delay: "5m", reason?: "training is still running" })`
records a time only. The current turn runs to completion; the next iteration
starts when the turn has finished **and** the delay has elapsed. Calling it twice
in one iteration keeps the last call. A fixed loop re-arms itself, so
`schedule_next_loop` is not offered there.

## Behaviour guarantees

- **Never overlapping.** At most one iteration is in flight per session. A tick
  that comes due while the agent is working starts nothing; the idle transition
  is what starts the coalesced iteration.
- **No backlog.** There is exactly one `nextRunAt`. A 5-minute loop whose
  iteration ran for 17 minutes starts **one** iteration when it finishes, not
  three.
- **No busy-spin.** An adaptive iteration that neither schedules nor stops pauses
  the loop. Nothing retries every second.
- **No firing after stop.** Every arm carries a token; stop, pause, resume and
  iteration start invalidate it, so a callback that outlives its arm is ignored
  rather than trusted.
- **No instant restart after an interrupt.** If the human aborts an iteration's
  turn, the next fixed tick is a full interval away.
- **Session scoped.** One loop per session, keyed by the live Agent. A closed
  session, a disposed Agent or a stopped profile leaves no timer behind. Loops
  are deliberately **not** persisted: a restarted harness starts with none, and
  restoring a session cannot resume a loop (seed events are never replayed).
- **No pollution of other turns.** `schedule_next_loop` / `stop_loop` are
  registered into the looping Agent's own scope only for the duration of an
  iteration turn, and the adaptive guidance is a scoped prompt section rendered
  only during that turn.

## Installation

The plugin is a bundle: one Host row, so a plain-context command registration is
global and `/loop` reaches every agent in a profile that lists the bundle. No
shipped agent preset is overridden.

```sh
dsh plugin --profile web add /home/lenovo/code/dsh-plugin/dsh-loop
dsh --profile web --dump-config | grep -A2 '^# == dsh-loop'   # verify the layer
# restart the profile for the bundle set to take effect
```

`headless`, `sdk-minimal`, `automation` and the other compositions do not list
this bundle, so they are unaffected by construction.

## Development

```sh
node scripts/link-dsh.mjs      # link the installed @deepseek-ai packages for standalone tests
npm test                       # 73 tests, none of which sleep on a real interval
bash scripts/acceptance.sh     # tests, composed profile, and a real dsh boot probe
```

`scripts/acceptance.sh` uses a throwaway `DSH_HOME` and an alternate port: it
never touches the developer's harness profile or its relay ports.

| Suite | What it proves |
|---|---|
| `test/parser.test.js` | the strict grammar, and that a prompt is never mistaken for a control word |
| `test/scheduler.test.js` | fixed/adaptive semantics on a manual clock: one follow-up per due tick, no overlap, no backlog, pause/resume, isolation, teardown |
| `test/races.test.js` | stale timer callbacks, due-tick/turn-end coincidence, stop and pause mid-iteration, repeated schedules |
| `test/integration.test.js` | the plugin over the real registries: `/loop` in the command registry, `.dsh/loop.md`, per-iteration tool scoping, the scoped prompt section, replay safety |
| `test/e2e-agent-loop.test.js` | the **production `AgentLoop`**: real turns per interval, real tool dispatch for `schedule_next_loop`, real pause/resume |

The plugin imports `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools`, declared
as `peerDependencies`. That is what makes a linked, out-of-tree plugin resolve the
running installation's copy instead of installing a second instance.

## Layout

```
src/parser.js    strict duration and argument grammar (no natural language)
src/service.js   LoopState, scheduler, iteration accounting, race fences
src/command.js   the human /loop front-end and its rendering
src/tools.js     the model-facing adaptive surface, scoped to an iteration
src/prompt.js    the iteration message and the scoped prompt section
```

The three concerns map to the repository's usual split (a state owner, a human
command, a model tool). They live in one package because an out-of-tree plugin is
one bundle directory; `./command` and `./tools` are exported separately, so the
split is still addressable if this ever moves in-tree.

## Difference from `/goal` and `ralph`

| | `/goal` | `ralph` | `/loop` |
|---|---|---|---|
| Driver | completion condition | fixed round budget | wall clock or model schedule |
| State | durable session events | none (script local) | process-local, session scoped |
| Session | same session | fresh child per round | same session |
| Ends when | objective completes / blocked | budget or worker self-report | `/loop stop`, `stop_loop`, session disposal |
| Survives restart | yes | no | no |

`/loop` is not a goal system and not a fresh-agent workflow loop: it is a
scheduler that feeds *the same* conversation.
