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
  let captured
  globalThis.window = { __ModuleLoader__: { load: spec => { captured = spec } } }
  const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')
  // The bundle is a script that calls window.__ModuleLoader__.load; evaluating
  // it in this realm is exactly what the harness's module loader does.
  await import(`data:text/javascript,${encodeURIComponent(source)}`)
  delete globalThis.window
  assert.ok(captured, 'client.js did not call __ModuleLoader__.load')
  return captured
}

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
})
