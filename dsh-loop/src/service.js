/** Session-scoped scheduler. Due iterations enter through Agent.followup(). */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ADAPTIVE_GUIDANCE, DEFAULT_MAINTENANCE_PROMPT, renderLoopIteration } from './prompt.js'

/** Largest delay a Node timer represents without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Stable loop failure vocabulary. */
export class LoopError extends Error {
  /** Create a human-readable error with a stable code. */
  constructor(message, code) {
    super(message)
    this.name = 'LoopError'
    this.code = code
  }
}

/** Generate a process-local loop identity. */
function newLoopId() {
  return `loop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Own one loop per live Agent, with one pending iteration and one next-run time. */
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
   * Inject the clock, timer and host collaborators.
   * @param options.ctx - context exposing agents and an optional logger.
   * @param options.now - clock, defaulting to Date.now.
   * @param options.timer - schedule(callback, delay) returning a disposer.
   * @param options.attachTools - optional per-iteration tool registrar.
   * @param options.toolsAvailable - predicate for scheduling-tool availability.
   * @param options.promptSection - whether system guidance is registered.
   * @param options.minIntervalMs - minimum fixed interval and adaptive delay.
   * @param options.defaultPrompt - fallback prompt.
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

  /** Select system-prompt guidance or the iteration-message fallback. */
  setPromptSectionAvailable(available) {
    this.#promptSection = available === true
  }

  /** Return the loop owned by this exact Agent instance, if any. */
  get(agent) {
    const state = this.#loops.get(agent)
    return state !== undefined && state.agent === agent ? state : undefined
  }

  /** Every live loop, for status surfaces and tests. */
  list() {
    return [...this.#loops.values()]
  }

  /** Start one loop; reject an existing active or paused loop. */
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
      // State generation captured by timer callbacks.
      revision: 1,
      armToken: 0,
      iteration: 0,
      createdAt: now,
      lastRunAt: undefined,
      // The first iteration is due immediately.
      nextRunAt: now,
      pauseReason: undefined,
      stopReason: undefined,
      scheduleRequest: undefined,
      resumeRequested: false,
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

  /** Stop scheduling and return the previous view; leave the current turn running. */
  stop(agent, reason = 'user') {
    const state = this.#require(agent)
    const view = this.view(state)
    view.running = this.#inIteration(state)
    state.phase = 'stopped'
    state.stopReason = reason
    state.nextRunAt = undefined
    state.revision += 1
    this.#disarm(state)
    this.#removeQueued(state)
    if (state.pending === undefined) this.#release(state)
    return view
  }

  /** Pause scheduling while retaining the loop configuration. */
  pause(agent, reason = 'user') {
    const state = this.#require(agent)
    if (state.phase === 'stopped') throw new LoopError('The loop is stopped.', 'LOOP_STOPPED')
    state.phase = 'paused'
    state.pauseReason = reason
    state.resumeRequested = false
    state.revision += 1
    this.#disarm(state)
    this.#removeQueued(state)
    if (state.pending === undefined) this.#disposeTools(state)
    return this.view(state)
  }

  /** Resume a paused loop with its next iteration due now. */
  resume(agent) {
    const state = this.#require(agent)
    if (state.phase === 'active') throw new LoopError('The loop is already active.', 'LOOP_ALREADY_ACTIVE')
    if (state.phase === 'stopped') throw new LoopError('The loop is stopped.', 'LOOP_STOPPED')
    state.phase = 'active'
    state.pauseReason = undefined
    state.resumeRequested = state.pending !== undefined
    state.scheduleRequest = undefined
    state.revision += 1
    state.nextRunAt = this.#now()
    this.#arm(state)
    this.#maybeStart(state)
    return this.view(state)
  }

  /** Record an adaptive schedule. The last request in an iteration wins. */
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
    return pending.turn !== undefined && pending.turn === state.currentTurn
      && (pending.phase === 'claimed' || pending.phase === 'admitted')
  }

  /** Snapshot loop state for status and prompt rendering. */
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

  /** On idle, finish any pending iteration and start due work. */
  onIdle(agent) {
    const state = this.get(agent)
    if (state === undefined) return
    if (state.pending !== undefined && state.pending.phase !== 'queued') {
      // Finalize pending work at the idle boundary.
      this.#finishIteration(state, state.pending.endReason ?? 'completed')
    }
    if (state.phase !== 'active') return
    this.#maybeStart(state)
  }

  /** Finalize the owning turn before another queued turn can begin. */
  onTurnEnd(agent, turn, reason) {
    const state = this.get(agent)
    const pending = state?.pending
    if (pending === undefined) return
    if (pending.turn !== turn) return
    this.#finishIteration(state, reason)
  }

  /** Track the current session turn. */
  onTurnStart(agent, turn) {
    const state = this.get(agent)
    if (state === undefined) return
    state.currentTurn = turn
  }

  /** Mark the pending message as admitted to the model surface. */
  onUserMessage(agent, messageId) {
    const state = this.get(agent)
    const pending = state?.pending
    if (pending === undefined || pending.messageId !== messageId) return
    const queued = pending.phase === 'queued'
    pending.phase = 'admitted'
    if (pending.turn === undefined) pending.turn = state.currentTurn
    if (queued) this.#registerTools(state)
  }

  /** Associate a claimed loop message with its owning turn. */
  onClaimed(agent, messageId, turn) {
    const state = this.get(agent)
    const pending = state?.pending
    if (pending === undefined || pending.messageId !== messageId) return
    const queued = pending.phase === 'queued'
    pending.phase = 'claimed'
    pending.turn = turn
    state.currentTurn = turn
    if (queued) this.#registerTools(state)
  }

  /** Release discarded work without waiting for an idle transition. */
  onDiscarded(agent, messageId) {
    const state = this.get(agent)
    const pending = state?.pending
    if (pending === undefined || pending.messageId !== messageId) return
    this.#finishIteration(state, 'discarded')
  }

  /** Release all loop state, timers and tool registrations. */
  dispose() {
    for (const state of [...this.#loops.values()]) {
      state.phase = 'stopped'
      state.revision += 1
      this.#disarm(state)
      this.#removeQueued(state)
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
    this.#removeQueued(state)
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
    // Check both timer and state generations to reject stale callbacks.
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

  /** Start due work only when the Agent is idle and no iteration is pending. */
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

    // Include adaptive guidance in the message if no prompt section exists.
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
    // Fixed loops arm the next tick after queuing this iteration.
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
    const resumeRequested = state.resumeRequested
    state.resumeRequested = false
    state.pending = undefined
    state.revision += 1
    state.lastEndReason = reason
    this.#disposeTools(state)

    if (state.phase !== 'active') {
      // Retain paused configuration; release stopped state.
      if (state.phase === 'stopped') this.#release(state)
      else {
        this.#disarm(state)
        this.#disposeTools(state)
      }
      return
    }

    const now = this.#now()
    if (state.mode === 'fixed') {
      if (reason === 'aborted' || reason === 'discarded') {
        // A human interrupt must not be answered by an instant restart.
        state.nextRunAt = Math.max(state.nextRunAt ?? now, now + state.intervalMs)
      }
      this.#arm(state)
      this.#maybeStart(state)
      return
    }

    if (resumeRequested) {
      // Human resume takes priority over the finishing iteration's schedule.
      state.scheduleRequest = undefined
      state.nextRunAt = now
      this.#arm(state)
      this.#maybeStart(state)
      return
    }

    const request = state.scheduleRequest
    state.scheduleRequest = undefined
    if (request === undefined) {
      // Pause unscheduled adaptive work, or release a dead Agent.
      if (this.#ctx.agents.get(state.agent.id) !== state.agent) this.#release(state)
      else this.pause(state.agent, 'awaiting-schedule')
      return
    }
    state.lastSchedule = request
    state.nextRunAt = request.at
    this.#arm(state)
    this.#maybeStart(state)
  }

  /** Remove an iteration that has not been claimed, preserving other inbox work. */
  #removeQueued(state) {
    const pending = state.pending
    if (pending?.phase !== 'queued') return
    state.agent.inbox.remove(pending.messageId)
    // Some Agent implementations do not publish inbox removal events.
    if (state.pending === pending) this.#finishIteration(state, 'discarded')
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
