/**
 * Deterministic test doubles: a manual clock/timer pair and a minimal Agent.
 *
 * Scheduling semantics are the part of this plugin that most needs exact
 * assertions ("exactly one follow-up", "no backlog", "stale timer ignored"), so
 * those tests drive {@link LoopService} directly through a manual timer queue
 * instead of real wall-clock waiting. Global timer mocking is deliberately
 * avoided here: the plugin's own timer is the only thing under test.
 */

/** One armed timer in the manual queue. */
let nextTimerId = 0

/**
 * A clock plus a timer queue that only advances when a test says so.
 * @param start - initial epoch milliseconds.
 * @returns `{ now, timer, advance, pending, fireStale }`.
 */
export function createManualClock(start = 1_700_000_000_000) {
  let now = start
  const timers = new Map()
  return {
    now: () => now,
    timer: {
      schedule(callback, delay) {
        const id = nextTimerId += 1
        timers.set(id, { at: now + Math.max(0, delay), callback })
        return () => timers.delete(id)
      },
    },
    /** Advance time, firing every timer in due order. */
    advance(ms) {
      const target = now + ms
      for (;;) {
        let earliest
        for (const [id, timer] of timers) {
          if (timer.at > target) continue
          if (earliest === undefined || timer.at < earliest[1].at) earliest = [id, timer]
        }
        if (earliest === undefined) break
        timers.delete(earliest[0])
        now = Math.max(now, earliest[1].at)
        earliest[1].callback()
      }
      now = target
    },
    /** Number of currently armed timers. */
    pending: () => timers.size,
    /**
     * Callback of the earliest armed timer, captured *without* cancelling it.
     * Used to invoke a callback after its arm was invalidated, which is how a
     * stale wake-up reaches the driver in a real process.
     */
    captureNext() {
      let earliest
      for (const timer of timers.values()) {
        if (earliest === undefined || timer.at < earliest.at) earliest = timer
      }
      if (earliest === undefined) throw new Error('captureNext: no armed timer')
      return earliest.callback
    },
  }
}

/**
 * Minimal Agent double: identity, status, session handle and follow-up capture.
 * @param options - id, session stub and an optional live registry.
 * @returns the double plus its recorded follow-ups.
 */
export function createAgentDouble({ id, session = { id }, live = true } = {}) {
  const followups = []
  const toolsDisposers = []
  const agent = {
    id,
    session,
    get status() {
      return live ? agent.__status : 'idle'
    },
    __status: 'idle',
    __live: live,
    followup(message) {
      followups.push(message)
    },
    cancel() {},
    whenIdle() {
      return Promise.resolve()
    },
  }
  return {
    agent,
    followups,
    toolsDisposers,
    /** Busy the Agent without running a turn. */
    setBusy() {
      agent.__status = 'running'
    },
    setIdle() {
      agent.__status = 'idle'
    },
  }
}

/**
 * A context shell exposing only what {@link LoopService} reads: the live agent
 * registry and an optional logger.
 * @param agents - Agent doubles that count as live.
 * @returns a context double.
 */
export function createCtxDouble(agents = []) {
  const registry = new Map(agents.map(agent => [agent.id, agent]))
  const warnings = []
  return {
    ctx: {
      agents: { get: id => registry.get(id) },
      logger: { warn: message => warnings.push(message) },
    },
    registry,
    warnings,
  }
}
