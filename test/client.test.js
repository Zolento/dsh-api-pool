import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** A tiny React stand-in: the component is only registered, never rendered here. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: value => [value, () => {}],
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useEffect: () => {},
}

/** Load the browser bundle in-process, capturing its loader registration. */
async function loadClientModule() {
  // The bundle is evaluated once per data: URL; later calls reuse the capture.
  if (cachedClientSpec !== undefined) return cachedClientSpec
  let captured
  globalThis.window = { __ModuleLoader__: { load: spec => { captured = spec } } }
  const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')
  // The bundle is a script that calls window.__ModuleLoader__.load; evaluating
  // it in this realm is exactly what the harness's module loader does.
  await import(`data:text/javascript,${encodeURIComponent(source)}`)
  delete globalThis.window
  assert.ok(captured, 'client.js did not call __ModuleLoader__.load')
  cachedClientSpec = captured
  return captured
}

let cachedClientSpec

function fakeClientContext() {
  const registered = []
  const effects = []
  const ctx = {
    locale: { bind: () => key => key, register: () => () => {} },
    effect: (fn) => { effects.push(fn) },
    configForms: { get: id => ({ id, subscribe: () => () => {}, getSnapshot: () => ({ status: 'ready', value: {}, writable: true }) }) },
    slots: {
      inject: (name, callback) => { callback() },
      register: (options, component) => { registered.push({ options, component }); return () => {} },
    },
  }
  return { ctx, registered, effects }
}

test('client.js registers the API Pool settings page', async () => {
  const spec = await loadClientModule()
  assert.equal(spec.id, 'dsh-api-pool')
  assert.equal(typeof spec.factory, 'function')

  const module = spec.factory(name => {
    if (name === 'react') return reactStub
    throw new Error(`unexpected require(${name})`)
  })
  assert.deepEqual(module.inject, ['slots', 'locale', 'configForms'])

  const { ctx, registered } = fakeClientContext()
  module.apply(ctx)
  assert.equal(registered.length, 1)
  const { options, component } = registered[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'api-pool')
  assert.equal(typeof options.label, 'function')
  const injected = options.inject()
  assert.equal(injected.form.id, 'dsh-api-pool')
  assert.equal(typeof component, 'function')

  // A non-loopback page (frp origin) cannot read Host settings: DSH switches
  // the form to memory mode, and the page must say so rather than claim the
  // namespace is missing.
  const unavailable = (mode) => component({
    ...injected,
    form: {
      getSnapshot: () => ({ status: 'unavailable', mode, value: undefined, writable: false }),
      subscribe: () => () => {},
      mutate: async () => false,
    },
  })
  assert.equal(unavailable('memory').children[0], 'unavailableMemory')
  assert.equal(unavailable('host').children[0], 'unavailableHost')
})

/**
 * Depth-first collect of rendered elements matching a predicate.
 *
 * The React stub only creates element objects, so function components are
 * expanded here the way React would render them.
 */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function') {
    return findAll(node.type({ ...node.props, children: node.children }), predicate, out)
  }
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  return out
}

async function renderSection(value) {
  const spec = await loadClientModule()
  const module = spec.factory(name => {
    if (name === 'react') return reactStub
    throw new Error(`unexpected require(${name})`)
  })
  const { ctx, registered } = fakeClientContext()
  module.apply(ctx)
  const { options, component } = registered[0]
  const injected = options.inject()
  const ops = []
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, value }),
    subscribe: () => () => {},
    mutate: async next => { ops.push(...next); return true },
  }
  return { tree: component({ ...injected, form }), ops }
}

test('the spend limit is refused above the observed budget, and accepted at or below it', async () => {
  const { tree, ops } = await renderSection({
    endpoints: [{ name: 'primary', baseURL: 'https://p.example/v1', budgetLimit: 30 }],
    observed: { primary: { maxBudget: 100 } },
  })

  // The cap the provider reported is shown, so the user knows the bound.
  assert.equal(findAll(tree, node => typeof node.children?.[0] === 'string'
    && node.children[0].includes('budgetLimitObserved')).length > 0, true,
  'the observed budget must be visible next to the field')

  const limitInput = findAll(tree, node => node.type === 'input' && node.props.value !== undefined)
    .find(node => String(node.props.value) === '30')
  assert.ok(limitInput, 'the spend limit input must render with its stored value')

  limitInput.props.onChange({ target: { value: '150' } })
  assert.deepEqual(ops, [], 'a value above the observed budget must not be written')

  limitInput.props.onChange({ target: { value: '100' } })
  assert.deepEqual(ops, [{ op: 'set', path: ['endpoints', 0, 'budgetLimit'], value: 100 }],
    'the observed budget itself is allowed')

  ops.length = 0
  limitInput.props.onChange({ target: { value: '' } })
  assert.deepEqual(ops, [{ op: 'unset', path: ['endpoints', 0, 'budgetLimit'] }], 'clearing removes the limit')

  ops.length = 0
  limitInput.props.onChange({ target: { value: 'abc' } })
  assert.deepEqual(ops, [], 'a non-numeric entry must not be written')
})

test('a limit cannot be set before any budget has been observed', async () => {
  const { tree, ops } = await renderSection({
    endpoints: [{ name: 'primary', baseURL: 'https://p.example/v1' }],
    observed: {},
  })
  const limitInput = findAll(tree, node => node.type === 'input' && node.props.placeholder === '50')[0]
  assert.ok(limitInput, 'the field must still render')
  limitInput.props.onChange({ target: { value: '50' } })
  assert.deepEqual(ops, [], 'without an observed budget the rule cannot be verified, so nothing is written')
})

test('a stored limit above the observed budget is flagged', async () => {
  const { tree } = await renderSection({
    endpoints: [{ name: 'primary', baseURL: 'https://p.example/v1', budgetLimit: 150 }],
    observed: { primary: { maxBudget: 100 } },
  })
  assert.equal(findAll(tree, node => typeof node.children?.[0] === 'string'
    && node.children[0] === 'budgetLimitStored').length > 0, true,
  'an oversized stored limit must be reported instead of silently enforced')
})
