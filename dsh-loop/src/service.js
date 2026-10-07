/**
 * The loop driver: session-scoped state machine, timer, and turn accounting.
 *
 * Architecture (see README): the loop is a *consumer* of the normal agent loop.
 * It never runs a model request itself, never touches `@deepseek-ai/dsh-agent-loop`,
 * and never forks a subagent. When an iteration is due and the Agent is idle it
 * calls `agent.followup(...)`, which is the same ordinary API `/goal` uses; the
 * resulting turn is an ordinary turn with normal tools, permissions, compaction
 * and session recording.
 *
 * Four invariants drive the implementation:
 *
 * - **Never overlap.** One `pending` iteration per loop. A due tick while an
 *   iteration runs (or while any other turn runs) starts nothing.
 * - **No backlog.** There is exactly one `nextRunAt`. Missed ticks collapse into
 *   it; they are never queued as extra iterations.
 * - **Never fire after a stop.** Every arm carries an `armToken`; invalidating
 *   the arm (stop, pause, reschedule, iteration start) increments it, so a stale
 *   timer callback is recognised and ignored rather than trusted.
 * - **Idle aware.** A due loop starts only when `agent.status === 'idle'`; the
 *   idle transition is what retries a tick that arrived while the Agent worked.
 *
 * @module dsh-loop/service
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ADAPTIVE_GUIDANCE, DEFAULT_MAINTENANCE_PROMPT, renderLoopIteration } from './prompt.js'

/** Largest delay a Node timer represents without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Stable loop failure vocabulary. */
export class LoopError extends Error {
  /**
   * @param message - human-readable failure, safe to show the human.
   * @param code - stable machine code.
   */
  constructor(message, code) {
    super(message)
    this.name = 'LoopError'
    this.code = code
  }
}

/** Monotonic-enough loop identity; process-local and never persisted. */
function newLoopId() {
  return `loop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Session-scoped loop driver. One instance per composed plugin; one active loop
 * per Agent (the map key is the Agent, so a future multi-loop revision changes
 * only this store, not the driver's callers).
 */
export class LoopService {
  #ctx
  #loops = new Map()
  #now
  #timer
  #attachTools
  #toolsAvailable
  #promptSection
  #minIntervalMs
  #defaultPrompt
  #logger

  /**
   * @param options - collaborators; every one is injectable so the driver is
   *   testable without a live harness.
   * @param options.ctx - context exposing `agents` (and used for logging).
   * @param options.now - clock, defaulting to `Date.now`.
   * @param options.timer - `{ schedule(callback, delay) }` returning a canceller.
   * @param options.attachTools - registers the model-facing control tools into
   *   the looping Agent's scope; `undefined` when the composition has no tools.
   * @param options.toolsAvailable - predicate for "the tools service exists
   *   yet"; defaults to "attachTools was supplied".
   * @param options.promptSection - whether a scoped system-prompt section exists
   *   (when it does, adaptive guidance lives there instead of in the message).
   * @param options.minIntervalMs - interval floor.
   * @param options.defaultPrompt - prompt used when none is supplied.
   */
  constructor(options) {
    this.#ctx = options.ctx
    this.#now = options.now ?? (() => Date.now())
    this.#timer = options.timer
    this.#attachTools = options.attachTools
    this.#toolsAvailable = options.toolsAvailable ?? (() => options.attachTools !== undefined)
    this.#promptSection = options.promptSection === true
    this.#minIntervalMs = options.minIntervalMs
    this.#defaultPrompt = options.defaultPrompt ?? DEFAULT_MAINTENANCE_PROMPT
    this.#logger = options.ctx?.logger
  }

  /** Interval floor enforced for every mode. */
  get minIntervalMs() {
    return this.#minIntervalMs
  }

  /** Prompt used when neither the command nor `.dsh/loop.md` supplies one. */
  get defaultPrompt() {
    return this.#defaultPrompt
  }

  /**
   * Record whether a scoped system-prompt section is composed. When it is, the
   * adaptive contract travels there; when it is not, the iteration message
   * carries it instead so adaptive mode still works.
   * @param available - true once the section is registered.
   */
  setPromptSectionAvailable(available) {
    this.#promptSection = available === true
  }

  /**
   * The loop owned by one exact live Agent, if any.
   * @param agent - exact Agent instance.
   * @returns the live loop state, or undefined.
   */
  get(agent) {
    const state = this.#loops.get(agent)
    return state !== undefined && state.agent === agent ? state : undefined
  }

  /** Every live loop, for status surfaces and tests. */
  list() {
    return [...this.#loops.values()]
  }

  /**
   * Start a loop. Session-scoped: at most one active or paused loop per Agent.
   * @param agent - exact live Agent.
   * @param options - prompt, mode and interval.
   * @returns the new loop state.
   */
  start(agent, options) {
    this.#assertLive(agent)
    const existing = this.get(agent)
    if (existing !== undefined) {
      throw new LoopError(
        `A loop is already ${existing.phase} in this session. Use /loop stop before starting another.`,
        'LOOP_ALREADY_ACTIVE',
      )
    }
    const mode = options.mode
    if (mode === 'fixed' && !(Number.isSafeInteger(options.intervalMs) && options.intervalMs >= this.#minIntervalMs)) {
      throw new LoopError(
        `A fixed loop needs an interval of at least ${this.#minIntervalMs}ms.`,
        'LOOP_INTERVAL_REQUIRED',
      )
    }
    if (mode === 'adaptive' && !this.#toolsAvailable()) {
      throw new LoopError(
        'An adaptive loop needs the tools service to expose its scheduling tool.',
        'LOOP_TOOLS_UNAVAILABLE',
      )
    }
    const now = this.#now()
    const state = {
      id: newLoopId(),
      agent,
      prompt: options.prompt,
      mode,
      intervalMs: mode === 'fixed' ? options.intervalMs : undefined,
      phase: 'active',
      // Bumped on every observable transition. Timers capture it, so a callback
      // that survives its arm is recognisable as stale.
      revision: 1,
      armToken: 0,
      iteration: 0,
      createdAt: now,
      lastRunAt: undefined,
      // The first iteration is due immediately: `/loop 5m x` should show work
      // now, then repeat, never wait a whole interval before doing anything.
      nextRunAt: now,
      pauseReason: undefined,
      stopReason: undefined,
      scheduleRequest: undefined,
      lastSchedule: undefined,
      pending: undefined,
      currentTurn: undefined,
      lastEndReason: undefined,
      timerDispose: undefined,
      toolsDispose: undefined,
    }
    this.#loops.set(agent, state)
    this.#arm(state)
    return state
  }

  /**
   * Stop a loop for good. The running turn is never cancelled: the current
   * iteration finishes normally and nothing follows it.
   * @param agent - exact live Agent.
   * @param reason - recorded reason.
   * @returns the final view, captured before the state is released.
   */
  stop(agent, reason = 'user') {
    const state = this.#require(agent)
    const view = this.view(state)
    state.phase = 'stopped'
    state.stopReason = reason
    state.nextRunAt = undefined
    state.revision += 1
    this.#disarm(state)
    if (state.pending === undefined) this.#release(state)
    return view
  }

  /**
   * Pause scheduling, keeping prompt, mode and interval for a later resume.
   * @param agent - exact live Agent.
   * @param reason - `user` or the driver's own `awaiting-schedule` fallback.
   * @returns the paused view.
   */
  pause(agent, reason = 'user') {
    const state = this.#require(agent)
    if (state.phase === 'stopped') throw new LoopError('The loop is stopped.', 'LOOP_STOPPED')
    state.phase = 'paused'
    state.pauseReason = reason
    state.revision += 1
    this.#disarm(state)
    if (state.pending === undefined) this.#disposeTools(state)
    return this.view(state)
  }

  /**
   * Resume a paused loop. Fixed and adaptive alike re-arm for *now*: resume is a
   * human cadence reset, and ticks missed while paused are not replayed.
   * @param agent - exact live Agent.
   * @returns the resumed view.
   */
  resume(agent) {
    const state = this.#require(agent)
    if (state.phase === 'active') throw new LoopError('The loop is already active.', 'LOOP_ALREADY_ACTIVE')
    if (state.phase === 'stopped') throw new LoopError('The loop is stopped.', 'LOOP_STOPPED')
    state.phase = 'active'
    state.pauseReason = undefined
    state.revision += 1
    state.nextRunAt = this.#now()
    this.#arm(state)
    this.#maybeStart(state)
    return this.view(state)
  }

  /**
   * Record the next iteration requested by an adaptive iteration's model turn.
   * The last call in one iteration wins; the current turn is untouched.
   * @param agent - exact live Agent.
   * @param request - absolute time plus the delay and reason that produced it.
   * @returns the recorded request.
   */
  scheduleNext(agent, request) {
    const state = this.#require(agent)
    if (state.mode !== 'adaptive') {
      throw new LoopError('This is a fixed-interval loop; it re-arms itself.', 'LOOP_NOT_ADAPTIVE')
    }
    if (!this.#inIteration(state)) {
      throw new LoopError('Scheduling is only valid inside a loop iteration turn.', 'LOOP_NOT_IN_ITERATION')
    }
    state.scheduleRequest = request
    state.revision += 1
    return request
  }

  /** Whether the Agent is currently inside one of this loop's iteration turns. */
  #inIteration(state) {
    const pending = state.pending
    if (pending === undefined) return false
    return pending.phase === 'claimed' || pending.phase === 'admitted'
  }

  /**
   * Read-only snapshot for status surfaces and the prompt section.
   * @param state - exact live state.
   * @returns a plain view object.
   */
  view(state) {
    return {
      id: state.id,
      mode: state.mode,
      phase: state.phase,
      pauseReason: state.pauseReason,
      stopReason: state.stopReason,
      intervalMs: state.intervalMs,
      iteration: state.iteration,
      createdAt: state.createdAt,
      lastRunAt: state.lastRunAt,
      nextRunAt: state.nextRunAt,
      prompt: state.prompt,
      running: state.pending !== undefined,
      inIteration: this.#inIteration(state),
      pendingIteration: state.pending?.iteration,
      lastEndReason: state.lastEndReason,
      lastSchedule: state.lastSchedule,
      scheduledByModel: state.scheduleRequest !== undefined,
    }
  }

  // ── driver triggers ───────────────────────────────────────────────────────

  /**
   * The Agent became idle: an iteration may have finished, and a due tick may
   * now be allowed to start.
   * @param agent - the Agent whose status changed.
   */
  onIdle(agent) {
    const state = this.get(agent)
    if (state === undefined) return
    if (state.pending !== undefined) {
      // Idle with a pending iteration means its turn closed (or its message was
      // discarded before starting). Either way the iteration is over, and the
      // driver may now compute the next obligation.
      this.#finishIteration(state, state.pending.endReason ?? 'completed')
    }
    if (state.phase !== 'active') return
    this.#maybeStart(state)
  }

  /**
   * A durable `turn/end` observed for one session; used only to classify why an
   * iteration's turn ended.
   * @param agent - the session's Agent, when live.
   * @param turn - the closed turn number.
   * @param reason - `TurnEndReason.kind`.
   */
  onTurnEnd(agent, turn, reason) {
    const state = this.get(agent)
    const pending = state?.pending
    if (pending === undefined) return
    if (pending.turn !== undefined && pending.turn !== turn) return
    pending.endReason = reason
  }

  /**
   * A durable `turn/start` observed for one session.
   * @param agent - the session's Agent, when live.
   * @param turn - the opened turn number.
   */
  onTurnStart(agent, turn) {
    const state = this.get(agent)
    if (state === undefined) return
    state.currentTurn = turn
  }

  /**
   * One of this loop's messages was admitted to the model surface.
   * @param agent - the session's Agent, when live.
   * @param messageId - admitted message id.
   */
  onUserMessage(agent, messageId) {
    const state = this.get(agent)
    const pending = state?.pending
    if (pending === undefined || pending.messageId !== messageId) return
    pending.phase = 'admitted'
    if (pending.turn === undefined) pending.turn = state.currentTurn
  }

  /**
   * One of this loop's messages left the inbox for a turn.
   * @param agent - the Agent whose inbox changed.
   * @param messageId - claimed message id.
   * @param turn - the owning turn.
   */
  onClaimed(agent, messageId, turn) {
    const state = this.get(agent)
    const pending = state?.pending
    if (pending === undefined || pending.messageId !== messageId) return
    pending.phase = 'claimed'
    pending.turn = turn
  }

  /**
   * One of this loop's messages was discarded before running.
   * @param agent - the Agent whose inbox changed.
   * @param messageId - discarded message id.
   */
  onDiscarded(agent, messageId) {
    const state = this.get(agent)
    const pending = state?.pending
    if (pending === undefined || pending.messageId !== messageId) return
    pending.endReason = 'discarded'
  }

  /**
   * Release every timer, tool registration and listener-owned state. Called by
   * the plugin's own effect disposer, so a stopped profile leaves no zombie
   * timer behind.
   */
  dispose() {
    for (const state of [...this.#loops.values()]) {
      state.revision += 1
      this.#disarm(state)
      this.#disposeTools(state)
      this.#loops.delete(state.agent)
    }
    this.#loops.clear()
  }

  /** Drop one Agent's loop with no further scheduling. */
  discard(agent) {
    const state = this.get(agent)
    if (state === undefined) return
    state.phase = 'stopped'
    state.revision += 1
    this.#disarm(state)
    this.#disposeTools(state)
    this.#loops.delete(agent)
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Fail unless the Agent is the exact live instance in the registry. */
  #assertLive(agent) {
    if (this.#ctx.agents.get(agent.id) !== agent) {
      throw new LoopError(`Session "${agent.id}" is not live.`, 'LOOP_AGENT_NOT_LIVE')
    }
  }

  /** Read an existing loop or fail with a human-readable reason. */
  #require(agent) {
    this.#assertLive(agent)
    const state = this.get(agent)
    if (state === undefined) throw new LoopError('No loop is active in this session.', 'LOOP_NONE')
    return state
  }

  /** Arm the single timer for `nextRunAt`, invalidating every earlier arm. */
  #arm(state) {
    this.#disarm(state)
    if (state.phase !== 'active' || state.nextRunAt === undefined) return
    // Two independent fences. `armToken` is the arm generation: every disarm
    // (including re-arm) increments it, so a callback that was already queued
    // when the timer was cancelled is recognised. `revision` is the loop-state
    // generation: it pins the state the arm was computed from, so a transition
    // that changed the loop between arming and firing cannot be acted on by a
    // stale wake-up. `clearTimeout` alone covers neither.
    const armToken = state.armToken += 1
    const revision = state.revision
    const delay = Math.max(0, Math.min(state.nextRunAt - this.#now(), MAX_TIMER_DELAY_MS))
    state.timerDispose = this.#timer.schedule(() => {
      if (state.armToken !== armToken || state.revision !== revision) return
      state.timerDispose = undefined
      this.#onTimer(state)
    }, delay)
  }

  /** Cancel the armed timer and invalidate its callback. */
  #disarm(state) {
    state.armToken += 1
    if (state.timerDispose !== undefined) {
      const dispose = state.timerDispose
      state.timerDispose = undefined
      try {
        dispose()
      } catch (error) {
        this.#warn(`timer disposal failed for ${state.id}: ${String(error)}`)
      }
    }
  }

  /** Timer wake-up: either a clamped early wake or a genuinely due tick. */
  #onTimer(state) {
    if (state.phase !== 'active') return
    const now = this.#now()
    if (state.nextRunAt !== undefined && state.nextRunAt > now) {
      // `MAX_TIMER_DELAY_MS` clamp: wake again at the real obligation.
      this.#arm(state)
      return
    }
    this.#maybeStart(state)
  }

  /**
   * Start an iteration only when it is due, nothing is running, and the Agent
   * is idle. Returning early is the "mark due" branch: `nextRunAt` stays in the
   * past and the next idle transition retries it exactly once.
   */
  #maybeStart(state) {
    if (state.phase !== 'active' || state.pending !== undefined) return false
    if (state.nextRunAt === undefined || state.nextRunAt > this.#now()) return false
    const agent = state.agent
    if (this.#ctx.agents.get(agent.id) !== agent) {
      this.discard(agent)
      return false
    }
    if (agent.status !== 'idle') return false
    this.#startIteration(state)
    return true
  }

  /** One ordinary follow-up turn carrying the stable loop prompt. */
  #startIteration(state) {
    const agent = state.agent
    const now = this.#now()
    state.iteration += 1
    state.revision += 1
    state.lastRunAt = now
    state.scheduleRequest = undefined
    state.nextRunAt = state.mode === 'fixed' ? now + state.intervalMs : undefined

    // Without a scoped prompt section the adaptive contract has to travel in
    // the message itself, or an adaptive iteration would have no way to know it
    // must schedule or stop.
    const adaptiveNote = this.#promptSection || state.mode !== 'adaptive' ? undefined : ADAPTIVE_GUIDANCE
    const message = createUserMessage({
      content: renderLoopIteration({
        prompt: state.prompt,
        iteration: state.iteration,
        adaptiveNote,
      }),
      source: { kind: 'loop', loopId: state.id, iteration: state.iteration },
    })
    state.pending = {
      iteration: state.iteration,
      messageId: message.id,
      phase: 'queued',
      turn: undefined,
      endReason: undefined,
    }
    this.#registerTools(state)
    // The timer that fired is consumed; a fixed loop re-arms below so a tick
    // that passes while this iteration runs is observed rather than lost.
    this.#disarm(state)
    try {
      agent.followup(message)
    } catch (error) {
      state.pending = undefined
      this.#disposeTools(state)
      state.phase = 'paused'
      state.pauseReason = 'queue-failed'
      state.revision += 1
      this.#warn(`could not queue iteration ${state.iteration} for ${agent.id}: ${String(error)}`)
      return
    }
    if (state.mode === 'fixed') this.#arm(state)
  }

  /** The iteration's turn closed: account for it and compute the next obligation. */
  #finishIteration(state, reason) {
    state.pending = undefined
    state.revision += 1
    state.lastEndReason = reason
    this.#disposeTools(state)

    if (state.phase !== 'active') {
      // Stopped or paused while the iteration ran. Nothing follows it, but a
      // paused loop keeps its prompt and interval for a later resume.
      if (state.phase === 'stopped') this.#release(state)
      else {
        this.#disarm(state)
        this.#disposeTools(state)
      }
      return
    }

    const now = this.#now()
    if (state.mode === 'fixed') {
      if (reason === 'aborted') {
        // A human interrupt must not be answered by an instant restart.
        state.nextRunAt = Math.max(state.nextRunAt ?? now, now + state.intervalMs)
      }
      this.#arm(state)
      this.#maybeStart(state)
      return
    }

    const request = state.scheduleRequest
    state.scheduleRequest = undefined
    if (request === undefined) {
      // The safe fallback for an adaptive iteration that neither scheduled nor
      // stopped: pause and say so, never spin. A dead Agent is released instead.
      if (this.#ctx.agents.get(state.agent.id) !== state.agent) this.#release(state)
      else this.pause(state.agent, 'awaiting-schedule')
      return
    }
    state.lastSchedule = request
    state.nextRunAt = request.at
    this.#arm(state)
    this.#maybeStart(state)
  }

  /** Release state that has no pending iteration left to clean up. */
  #release(state) {
    this.#disarm(state)
    this.#disposeTools(state)
    if (this.#loops.get(state.agent) === state) this.#loops.delete(state.agent)
  }

  /** Register the model-facing control surface for one iteration turn. */
  #registerTools(state) {
    if (this.#attachTools === undefined) return
    this.#disposeTools(state)
    try {
      state.toolsDispose = this.#attachTools(state)
    } catch (error) {
      state.toolsDispose = undefined
      this.#warn(`could not register loop tools for ${state.agent.id}: ${String(error)}`)
    }
  }

  /** Unregister the control surface so non-loop turns never see it. */
  #disposeTools(state) {
    if (state.toolsDispose === undefined) return
    const dispose = state.toolsDispose
    state.toolsDispose = undefined
    try {
      dispose()
    } catch (error) {
      this.#warn(`loop tool disposal failed for ${state.agent.id}: ${String(error)}`)
    }
  }

  /** Contained warning: a driver failure must never break the Agent. */
  #warn(message) {
    if (this.#logger !== undefined) this.#logger.warn(`dsh-loop: ${message}`)
  }
}
