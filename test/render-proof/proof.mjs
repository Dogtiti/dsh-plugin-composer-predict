// Renders the EXACT CSS string the shipped client.js emits, into the host's real
// placeholder structure, then leaves one HTML file per case for headless Chrome.
import { writeFileSync } from 'node:fs'

let registration
globalThis.window = { __ModuleLoader__: { load: (definition) => { registration = definition } } }
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })

let plan = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState(initial) {
    const planned = plan.length > 0 ? plan.shift() : undefined
    const value = planned !== undefined ? planned : typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
}

await import('/Users/dogtiti/workspace/deepseek-sessions/composer-predict/client.js')

const registered = []
const module = registration.factory(() => React)
module.apply({
  effect: (callback) => callback(),
  slots: {
    inject: (_key, callback) => callback(),
    register: (definition, component) => {
      registered.push({ definition, component })
      return () => {}
    },
  },
})

/** Ask the shipped component for its style text, with one suggestion. */
function cssFor(text) {
  const sessionId = 'session-proof'
  const props = {
    sessionId,
    useInput: (select) => select({ draft: '', attachmentIds: [], phase: 'plain' }),
    useSession: (select) => select({ running: false, blank: false, removed: false, subagent: null }),
    inputActions: { setDraft() {} },
  }
  plan = [0, { key: `${sessionId}:0`, text }, 'placeholder']
  const outer = registered[0].component(props)
  const body = outer.type(outer.props)
  return body.children.join('')
}

const HOST_CSS = `
  :root{--dsw-alias-label-primary:#1a1a1a;--dsw-alias-label-caption:#9a9a9a;
        --dsw-font-family:-apple-system,"PingFang SC",sans-serif;--dsw-specific-input-major:#fff}
  body{background:#fafafa;margin:0;padding:26px;font-family:var(--dsw-font-family)}
  .card{box-sizing:border-box;width:520px;border-radius:20px;background:var(--dsw-specific-input-major);
        box-shadow:0 1px 3px rgba(0,0,0,.12);font-size:14px;line-height:24px;
        display:flex;flex-direction:column;padding-top:8px;position:relative;margin-bottom:22px}
  .grow{position:relative}
  .input{box-sizing:border-box;min-height:36px;font-size:inherit;line-height:inherit;white-space:pre-wrap;
         color:var(--dsw-alias-label-primary);padding:4px 8px 0 14px}
  .placeholder{color:var(--dsw-alias-label-caption);white-space:nowrap;text-overflow:ellipsis;
               pointer-events:none;user-select:none;position:absolute;inset:4px 8px auto 14px;overflow:hidden}
  .cap{font:12px/16px var(--dsw-font-family);color:#888;margin:0 0 6px}
  /* control: undo the repaint so the native placeholder stays visible */
  #control [data-composer-placeholder]{color:var(--dsw-alias-label-caption)!important}
  #control [data-composer-placeholder]::after{content:none!important}
`

/** One card; `hostile` sets the app's font-size variable to a non-length. */
function card(label, id, hostile) {
  const attr = hostile ? ' style="--dsh-content-font-size:14"' : ''
  return `
  <p class="cap">${label}</p>
  <div class="card" id="${id}"${attr}><div class="grow">
    <div class="input" contenteditable="true"></div>
    <div class="placeholder" data-composer-placeholder>发消息或创建任务, / 调用指令, @ 文件或对话</div>
  </div></div>`
}

/** One page carrying the emitted rule verbatim. */
function page(css, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${HOST_CSS}</style>
<style id="shipped">${css}</style></head><body>${body}</body></html>`
}

writeFileSync('/tmp/asarx/repro/proof-a.html', page(cssFor('跑一下测试'),
  card('① 宿主原生占位（对照）', 'control', false) +
  card('② 插件规则 · 正常环境', 'normal', false) +
  card('③ 插件规则 · 敌意环境（--dsh-content-font-size = 14，非法长度）', 'hostile', true)))

writeFileSync('/tmp/asarx/repro/proof-b.html', page(cssFor('把刚才的改动整理成一个 commit，并补上缺失的单元测试和 README，然后开一个 PR 给团队评审'),
  card('④ 长建议（应与输入框同宽、省略号截断）', 'long', true)))

console.log('shipped css:', cssFor('跑一下测试'))
