import assert from 'node:assert/strict'
import test from 'node:test'

/** Planned `useState` values for the next component call. */
let statePlan = []

/** Minimal React stand-in: the module only builds element trees and reads Hooks. */
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    const planned = statePlan.length > 0 ? statePlan.shift() : undefined
    const value = planned !== undefined ? planned : typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial }
  },
  useCallback(fn) {
    return fn
  },
}

let registration
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      registration = definition
    },
  },
}
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })

await import('../client.js')

/**
 * Build a Client context stand-in that records slot and locale registrations.
 * @returns captured registrations.
 */
function fakeClient() {
  const captured = { slots: [], locales: [] }
  const ctx = {
    effect(callback) {
      callback()
    },
    locale: {
      register(namespace, dictionaries) {
        captured.locales.push({ namespace, dictionaries })
        return () => {}
      },
    },
    slots: {
      inject(ownerKey, callback) {
        captured.ownerKey = ownerKey
        callback()
      },
      register(definition, component) {
        captured.slots.push({ definition, component })
        return () => {}
      },
    },
  }
  return { ctx, captured }
}

/**
 * Render the registered component against one composer snapshot.
 * @param overrides - snapshot and props overrides.
 * @returns the produced element tree, or null.
 */
function render(overrides = {}) {
  const { component } = (() => {
    const { ctx, captured } = fakeClient()
    registration.factory(() => React).apply(ctx)
    return captured.slots[0]
  })()
  const input = { draft: '', attachmentIds: [], phase: 'plain', ...(overrides.input ?? {}) }
  const session = { running: false, blank: false, removed: false, subagent: null, ...(overrides.session ?? {}) }
  const sessionId = 'session-test'
  const props = {
    sessionId,
    useInput: (select) => select(input),
    useSession: (select) => select(session),
    inputActions: { setDraft() {} },
    t: (key) => (key === 'hint.tab' ? 'Tab' : key),
  }
  statePlan = [0, overrides.entry === null ? null : { key: `${sessionId}:0`, text: overrides.entry ?? '跑一下测试' }]
  if (overrides.surface !== undefined) statePlan.push(overrides.surface)
  const outer = component(props)
  if (outer === null) return null
  return outer.type(outer.props)
}

test('registers one composer dock entry', () => {
  assert.equal(registration.id, 'dsh-plugin-composer-predict')
  const module = registration.factory((spec) => {
    assert.equal(spec, 'react')
    return React
  })
  assert.deepEqual(module.inject, ['slots'])

  const { ctx, captured } = fakeClient()
  module.apply(ctx)

  assert.equal(captured.ownerKey, 'conversation.composer.dock')
  assert.equal(captured.slots.length, 1)
  assert.deepEqual(captured.slots[0].definition, {
    name: 'conversation.composer.dock',
    id: 'composer-predict',
    order: 0,
  })
  assert.equal(typeof captured.slots[0].component, 'function')
})

test('repaints the composer placeholder with the prediction', () => {
  const node = render({ entry: '跑一下测试' })
  assert.equal(node.type, 'style')
  const css = node.children.join('')
  assert.match(css, /\[data-composer-placeholder\]\{color:transparent!important;\}/)
  assert.doesNotMatch(css, /font-size:0/)
  assert.match(css, /::after\{content:"跑一下测试";position:absolute;inset:0/)
  assert.match(css, /content:"跑一下测试"/)
  assert.doesNotMatch(css, /content:"Tab"/)
  assert.doesNotMatch(css, /::before/)
})

test('escapes quotes and backslashes in the suggestion', () => {
  const node = render({ entry: 'run "npm test" \\ again' })
  const css = node.children.join('')
  assert.match(css, /content:"run \\"npm test\\" \\\\ again"/)
})

test('paints nothing while the composer is not empty', () => {
  assert.equal(render({ input: { draft: '已经写了一半' } }), null)
})

test('paints nothing while a command chip is claimed or a turn is running', () => {
  assert.equal(render({ input: { phase: 'claimed' } }), null)
  assert.equal(render({ session: { running: true } }), null)
})

test('paints nothing before a prediction exists', () => {
  assert.equal(render({ entry: null }), null)
})

test('falls back to a composer row when the placeholder repaint did not land', () => {
  const node = render({ entry: '跑一下测试', surface: 'row' })
  assert.equal(node.type, 'div')
  assert.equal(node.props.style.justifyContent, 'flex-end')
  assert.equal(node.children[0].type, 'button')
  assert.deepEqual(node.children[0].children[0].children, ['跑一下测试'])
})
