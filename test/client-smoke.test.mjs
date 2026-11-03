/**
 * Smoke test for the client bundle: install a fake `window.__ModuleLoader__`
 * and a fake React, load lib/client.js the way the DSH shell would, and check
 * that apply() registers the button, overlay dialog, shortcut and command UI
 * entries.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const loaded = {}
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded.entry = entry
    },
  },
}
const styles = []
globalThis.document = {
  baseURI: 'http://127.0.0.1:7184/',
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  documentElement: { appendChild: (node) => styles.push(node) },
  head: { appendChild: (node) => styles.push(node) },
}

const fakeReact = {
  createElement: (...args) => ({ type: 'element', args }),
  useReducer: (_reducer, initial) => [initial, () => {}],
  useEffect: () => {},
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
}

await import(new URL('../lib/client.js', import.meta.url).href)

function loadClientModule() {
  assert.equal(loaded.entry.id, 'dsh-btw')
  assert.equal(typeof loaded.entry.factory, 'function')
  return loaded.entry.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`unexpected require: ${name}`)
  })
}

function makeScope(services, state) {
  return {
    ...services,
    effect(fn) {
      const result = fn()
      return () => {
        state.effects += 1
        if (typeof result === 'function') result()
      }
    },
  }
}

test('client bundle loads through __ModuleLoader__ and exposes apply/inject', () => {
  const module = loadClientModule()
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots'])
})

test('apply() registers slots and the /btw action (no global shortcut)', () => {
  const state = { injections: [], slots: [], shortcuts: [], commands: [], effects: 0, disposed: 0 }

  const slotsService = {
    inject(name, callback) {
      state.injections.push(name)
      return callback()
    },
    register(options) {
      state.slots.push(options)
      return () => { state.disposed += 1 }
    },
  }
  const commandUiService = {
    register(options) {
      state.commands.push(options)
      return () => { state.disposed += 1 }
    },
  }

  const ctx = {
    inject(deps, callback) {
      assert.equal(deps.length, 1)
      const name = deps[0]
      if (name === 'slots') return callback(makeScope({ slots: slotsService }, state))
      if (name === 'commandUi') return callback(makeScope({ commandUi: commandUiService }, state))
      throw new Error(`unexpected deps: ${deps.join(',')}`)
    },
  }

  loadClientModule().apply(ctx)

  assert.deepEqual(state.injections, ['conversation.input.right', 'shell.overlay'])
  assert.deepEqual(state.slots, [
    { name: 'conversation.input.right', id: 'btw:button', order: 40 },
    { name: 'shell.overlay', id: 'btw:dialog', order: 50 },
  ])

  // Ctrl+Alt+B belongs to DSH core (sidebar.left/right.toggle); registering it
  // here used to fail layout activation at boot, so the plugin must not.
  assert.equal(state.shortcuts.length, 0)
  assert.equal(state.commands.length, 1)
  const command = state.commands[0]
  assert.equal(command.name, 'btw')
  assert.equal(command.ui.kind, 'action')
  assert.equal(command.available(undefined), false)
  assert.equal(command.available({ sessionId: 's1' }), true)

  assert.ok(styles.length >= 1)
  const css = styles[0].textContent
  assert.ok(css.includes('.btw-trigger'))
  assert.ok(css.includes('.btw-window'))
  assert.ok(css.includes('.btw-actions'))
  assert.ok(css.includes('.btw-msg-body'))
  assert.ok(css.includes('.btw-context'))
  assert.ok(css.includes('.btw-select'))
  assert.ok(css.includes('.btw-model'))
  assert.ok(css.includes('.btw-settings'))
  assert.ok(css.includes('.btw-focus'))
  assert.ok(css.includes('.btw-focus-clear'))
  assert.ok(css.includes('.btw-transfer-btn'))
  assert.ok(css.includes('.btw-transfer-panel'))
  assert.ok(!css.includes('.btw-away'))
  assert.ok(!css.includes('.btw-msg-action'))

  // Switching sessions hides a dialog (and stashes its conversation); only the
  // close button clears it. The old `noteSession()` auto-close helper is gone.
  // Answers are no longer copied or inserted verbatim: only a reviewed summary
  // can be written into the parent session.
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(!source.includes('noteSession'))
  assert.ok(source.includes('stashDialog'))
  assert.ok(source.includes('restoreDialog'))
  assert.ok(!source.includes('conversation.chat.assistant-actions'))
  assert.ok(!source.includes('insertTarget'))
  assert.ok(!source.includes('insertAnswer'))
  assert.ok(!source.includes('copyText'))
  assert.ok(source.includes('summarizeTransfer'))
  assert.ok(source.includes('commitTransfer'))

  assert.equal(state.disposed, 0) // disposers are returned to Cordis, not called eagerly
})
