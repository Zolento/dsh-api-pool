/**
 * Loopback OpenAI-compatible relay.
 *
 * DeepSeek Harness's `llm-pi-ai` adapter already translates the harness
 * message/tool/stream vocabulary for an `openai-completions` route. This relay
 * sits behind such a route and adds the pool: it forwards each request to the
 * selected endpoint, applies the pool's failover when a failure arrives before
 * any byte was streamed, and passes a successful response through untouched
 * (streaming SSE included).
 *
 * Conversation state is never held here: the harness re-sends the full message
 * history on every request, so switching endpoints mid-conversation is safe.
 */

import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { classifyError, classifyTransportError } from './pool/kinds.js'

const MAX_BODY_BYTES = 64 * 1024 * 1024

/** Failure carrying the pool's classification and the upstream body to relay. */
export class RelayFailure extends Error {
  /** @param {object} info classified ErrorInfo from `classifyError`. */
  constructor(info, upstream) {
    super(info.message === '' ? `upstream request failed (${info.kind})` : info.message)
    this.name = 'RelayFailure'
    this.poolInfo = info
    this.upstream = upstream
  }
}

/** Read a request body as a UTF-8 string with a hard size bound. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Headers safe to copy from an upstream response. */
const DROP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-length', 'content-encoding',
])

function copyResponseHeaders(upstream, res) {
  for (const [key, value] of upstream.headers) {
    if (DROP_RESPONSE_HEADERS.has(key.toLowerCase())) continue
    try {
      res.setHeader(key, value)
    } catch { /* a header the local server refuses is not worth failing the request */ }
  }
}

/** One OpenAI-style error response. */
function sendError(res, status, message, code) {
  const payload = JSON.stringify({ error: { message, type: code, code: String(status) } })
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

/** Build the upstream request URL for one endpoint. */
export function upstreamURL(spec) {
  const base = String(spec.baseURL).replace(/\/+$/, '')
  return `${base}/chat/completions`
}

/**
 * The relay server.
 */
export class Relay {
  /**
   * @param {object} options
   * @param {import('./pool/pool.js').ApiPool} options.pool
   * @param {string} options.token shared secret the harness must present.
   * @param {string} [options.basePath] path prefix the provider profile uses.
   * @param {string[]} [options.models] advertised models for `GET /models`.
   * @param {object} [options.logger]
   */
  constructor({ pool, token, basePath = '/v1', models = [], logger }) {
    this.pool = pool
    this.token = token
    this.basePath = basePath.replace(/\/+$/, '')
    this.models = models
    this.logger = logger
    this.server = undefined
    this.port = undefined
  }

  /** Start listening on the loopback interface.
   * @param {number} [port] requested port; 0 selects an ephemeral one.
   * @returns {Promise<{port: number, url: string}>}
   */
  listen(port = 0) {
    if (this.server !== undefined) return Promise.resolve({ port: this.port, url: this.url })
    this.server = createServer((req, res) => {
      // An unhandled 'error' on either side (client reset, write-after-close)
      // would surface as an uncaught exception and take the harness down.
      req.on('error', error => this.logger?.warn?.(`api-pool relay: request error: ${String(error)}`))
      res.on('error', error => this.logger?.warn?.(`api-pool relay: response error: ${String(error)}`))
      this.handle(req, res).catch((error) => {
        this.logger?.warn?.(`api-pool relay: unhandled request failure: ${String(error)}`)
        if (!res.headersSent) sendError(res, 500, String(error?.message ?? error), 'relay_error')
        else if (!res.destroyed) res.destroy()
      })
    })
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port
        resolve({ port: this.port, url: this.url })
      })
    })
  }

  /** The loopback base URL the provider profile should point at. */
  get url() {
    return `http://127.0.0.1:${this.port ?? 0}`
  }

  /** Stop the server and release the port (idle keep-alive sockets included). */
  close() {
    return new Promise((resolve) => {
      if (this.server === undefined) {
        resolve()
        return
      }
      const server = this.server
      this.server = undefined
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  }

  /** Constant-time-ish token comparison (length-safe, not secret-perfect). */
  authorized(req) {
    if (this.token === undefined || this.token === '') return true
    const header = req.headers['x-api-key'] ?? req.headers.authorization
    if (typeof header !== 'string') return false
    const presented = header.startsWith('Bearer ') ? header.slice(7) : header
    if (presented.length !== this.token.length) return false
    let diff = 0
    for (let index = 0; index < presented.length; index++) diff |= presented.charCodeAt(index) ^ this.token.charCodeAt(index)
    return diff === 0
  }

  async handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/healthz') {
      const totals = this.pool.totals()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        provider: 'dsh-api-pool',
        totalSpend: totals.spendUsd,
        spendSince: totals.since,
        endpoints: this.pool.status(),
      }))
      return
    }
    if (!this.authorized(req)) {
      sendError(res, 401, 'dsh-api-pool: missing or invalid relay token', 'authentication_error')
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: this.models.map(id => ({ id, object: 'model' })) }))
      return
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      sendError(res, 404, `dsh-api-pool: no route for ${req.method} ${url.pathname}`, 'not_found')
      return
    }

    const rawBody = await readBody(req)
    let parsed
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      sendError(res, 400, 'dsh-api-pool: request body is not valid JSON', 'invalid_request_error')
      return
    }

    const controller = new AbortController()
    // Detect a *client disconnect*: `req`'s 'close' fires on normal request
    // completion too (Node emits it once the body is read), so only the
    // response's close — before we finished writing it — means the caller left.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort(new Error('client disconnected'))
    })

    let result
    try {
      result = await this.pool.execute(
        (spec, apiKey, context) => this.attempt(spec, apiKey, parsed, controller.signal, context),
        { signal: controller.signal },
      )
    } catch (error) {
      this.respondWithFailure(res, error)
      return
    }

    const upstream = result.response
    res.statusCode = upstream.status
    copyResponseHeaders(upstream, res)
    await this.forwardBody(upstream, result.endpoint, res)
  }

  /**
   * Forward one upstream body to the client, containing every asynchronous
   * failure. An upstream that stalls or resets mid-body makes the web stream
   * reject; without this, the resulting 'error' event is unhandled and kills
   * the whole harness process.
   */
  async forwardBody(upstream, endpoint, res) {
    if (upstream.body === null || upstream.body === undefined) {
      res.end()
      return
    }
    const source = Readable.fromWeb(upstream.body)
    // A dead client must not leave the upstream reader open.
    res.on('error', () => source.destroy())
    res.on('close', () => { if (!res.writableEnded) source.destroy(new Error('client disconnected')) })
    try {
      await pipeline(source, res)
    } catch (error) {
      const code = error?.cause?.code ?? error?.code ?? error?.name ?? 'stream_error'
      this.logger?.warn?.(`api-pool relay: upstream body ended early on "${endpoint}" (${code}); closing the response`)
      this.pool.config.events?.emit?.('relay_error', {
        endpoint, code, message: String(error?.message ?? error).slice(0, 300),
      })
      if (!res.destroyed) res.destroy()
    }
  }

  /** One upstream attempt: returns a successful `fetch` response or throws RelayFailure. */
  async attempt(spec, apiKey, parsed, signal, context) {
    const body = { ...parsed }
    if (spec.model !== undefined) body.model = spec.model
    const timeout = AbortSignal.timeout(this.pool.config.requestTimeoutMs)
    const fused = AbortSignal.any([signal, timeout])
    let response
    try {
      response = await fetch(upstreamURL(spec), {
        method: 'POST',
        signal: fused,
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
          'x-dsh-api-pool': '1',
        },
        body: JSON.stringify(body),
      })
    } catch (error) {
      if (signal.aborted) throw error
      const info = classifyTransportErrorForRelay(error, timeout)
      throw new RelayFailure(info)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const info = classifyError({ status: response.status, headers: response.headers, body: text })
      throw new RelayFailure(info, { status: response.status, headers: response.headers, body: text })
    }
    return { response, endpoint: spec.name, headers: response.headers, attempt: context.attempt }
  }

  /** Convert a finished pool failure into an HTTP response for the harness. */
  respondWithFailure(res, error) {
    if (!res.headersSent) {
      if (error instanceof RelayFailure && error.upstream !== undefined) {
        res.statusCode = error.upstream.status
        for (const [key, value] of error.upstream.headers ?? []) {
          if (DROP_RESPONSE_HEADERS.has(String(key).toLowerCase())) continue
          try { res.setHeader(key, value) } catch { /* ignore */ }
        }
        res.end(error.upstream.body)
        return
      }
      const code = error?.code ?? 'relay_error'
      // 429 keeps the harness's own retry policy interested for transient pool exhaustion.
      const status = code === 'ALL_ENDPOINTS_UNAVAILABLE' ? 503 : 502
      sendError(res, status, String(error?.message ?? error), code)
      return
    }
    res.destroy()
  }
}

/** Classify a fetch rejection, distinguishing our own per-attempt timeout. */
function classifyTransportErrorForRelay(error, timeoutSignal) {
  const timedOut = timeoutSignal.aborted
  const info = classifyTransportError(error)
  if (timedOut) info.kind = 'timeout'
  return info
}
