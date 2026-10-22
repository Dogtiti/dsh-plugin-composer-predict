/**
 * Client half of the composer-prediction bundle.
 *
 * Primary surface: the prediction repaints the composer's own placeholder, so the
 * suggestion appears exactly where the user types. If that repaint cannot be applied
 * (the shipped placeholder markup moved, or a style policy blocks the injected rule),
 * the component falls back to a compact row under the composer instead of showing
 * nothing. Tab fills the prediction in as an ordinary editable draft either way.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-composer-predict',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Route registered by the Host half, addressed document-relatively. */
    const ROUTE = 'api/composer.predict'

    /** Diagnostic route; the Host half appends one line per report. */
    const REPORT = 'api/composer.report'

    /**
     * The shipped composer placeholder element. Its geometry, typography, IME hiding,
     * and empty-draft lifetime are the host's; this plugin only repaints its content.
     */
    const PLACEHOLDER = '[data-composer-placeholder]'

    /** Inline styles for the fallback row, so it renders even when `<style>` is blocked. */
    const ROW = {
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: '4px',
        minWidth: '0',
        padding: '0 2px',
        fontFamily: 'inherit',
      },
      hint: {
        display: 'inline-flex',
        alignItems: 'center',
        minWidth: '0',
        maxWidth: '100%',
        padding: '1px 6px',
        border: 'none',
        borderRadius: '8px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
        textAlign: 'left',
      },
      text: {
        minWidth: '0',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      dismiss: {
        flex: 'none',
        display: 'grid',
        placeItems: 'center',
        width: '18px',
        height: '18px',
        padding: '0',
        border: 'none',
        borderRadius: '999px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '1',
        cursor: 'pointer',
      },
    }

    /** Whether a transport or repaint problem was already reported in this page. */
    let warned = false

    /** Whether an empty prediction was already reported in this page. */
    let quiet = false

    /**
     * Escape one string for a double-quoted CSS `content` value.
     * @param text - plain text.
     * @returns the escaped value.
     */
    function cssString(text) {
      return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\t]/g, ' ')
    }

    /**
     * Build the rule set that repaints the composer placeholder.
     * The host's element already owns the geometry, font, ellipsis, and IME hiding;
     * this only swaps its text for the prediction.
     * @param text - predicted instruction.
     * @returns CSS text.
     */
    function ghostCss(text) {
      return [
        /* Keep the host's text node (its layout is already right) but make it invisible;
         * the repaint is an absolute overlay, so it needs no font-size trick and no CSS
         * variable that may not resolve to a length. */
        `${PLACEHOLDER}{color:transparent!important;}`,
        `${PLACEHOLDER}::after{content:"${cssString(text)}";position:absolute;inset:0;color:var(--dsw-alias-label-caption,#9a9a9a);font:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}`,
      ].join('')
    }

    /**
     * Send one diagnostic snapshot to the Host half. Never throws.
     * @param payload - plain JSON snapshot.
     */
    async function sendReport(payload) {
      try {
        await fetch(new URL(REPORT, document.baseURI), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'same-origin',
        })
      } catch {
        /* Diagnostics never affect the feature. */
      }
    }

    /**
     * Ask the Host half for this Session's prediction.
     * @param sessionId - Session to predict for.
     * @param signal - cancellation.
     * @returns the instruction, or null when none is available.
     */
    async function requestSuggestion(sessionId, signal) {
      const response = await fetch(new URL(ROUTE, document.baseURI), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
        credentials: 'same-origin',
        signal,
      })
      if (!response.ok) {
        if (warned !== true && response.status !== 404) {
          warned = true
          console.warn(`[composer-predict] prediction route answered ${response.status}`)
        }
        return null
      }
      const data = await response.json()
      const suggestion = data?.suggestion
      if (typeof suggestion !== 'string' || suggestion.trim() === '') {
        if (quiet !== true) {
          quiet = true
          console.info('[composer-predict] the host returned no suggestion', data)
        }
        return null
      }
      return suggestion.trim()
    }

    /**
     * Guard the slot's standard props before any hook runs.
     * @param props - slot standard props.
     * @returns the painter, or null when this slot lacks the composer hooks.
     */
    function PlaceholderPainter(props) {
      if (typeof props.useInput !== 'function' || typeof props.useSession !== 'function') return null
      if (props.inputActions === undefined || props.inputActions === null) return null
      if (typeof props.sessionId !== 'string' || props.sessionId === '') return null
      return h(PainterBody, props)
    }

    /**
     * Own the prediction lifecycle and paint it, in-box when possible.
     * @param props - slot standard props.
     * @returns the painted style element, a fallback row, or null.
     */
    function PainterBody(props) {
      const { sessionId, useSession, useInput, inputActions } = props
      const draft = useInput((snapshot) => snapshot.draft)
      const attachmentCount = useInput((snapshot) => snapshot.attachmentIds.length)
      const phase = useInput((snapshot) => snapshot.phase)
      const running = useSession((snapshot) => snapshot.running)
      const blank = useSession((snapshot) => snapshot.blank)
      const removed = useSession((snapshot) => snapshot.removed)
      const subagentMode = useSession((snapshot) => snapshot.subagent?.address?.mode ?? null)

      const [generation, setGeneration] = React.useState(0)
      const [entry, setEntry] = React.useState(null)
      const [surface, setSurface] = React.useState('placeholder')
      const anchorRef = React.useRef(null)
      const previousRunning = React.useRef(running === true)

      React.useEffect(() => {
        const wasRunning = previousRunning.current
        previousRunning.current = running === true
        if (wasRunning && running !== true) setGeneration((value) => value + 1)
      }, [running])

      const idle = running !== true && blank !== true && removed !== true
      const writable = subagentMode === null || subagentMode === 'continuable'
      const key = `${sessionId}:${generation}`

      React.useEffect(() => {
        if (!idle || !writable) return undefined
        const controller = new AbortController()
        let live = true
        setEntry((current) => (current?.key === key ? current : { key, text: null }))
        requestSuggestion(sessionId, controller.signal)
          .then((text) => {
            if (live) setEntry({ key, text })
          })
          .catch(() => {
            if (live) setEntry({ key, text: null })
          })
        return () => {
          live = false
          controller.abort()
        }
      }, [idle, writable, key, sessionId])

      const suggestion = entry?.key === key ? entry.text : null
      /* The host renders its placeholder under exactly these conditions; matching them
       * keeps the repaint attached to a real element instead of racing it. */
      const paints = typeof suggestion === 'string' && suggestion !== '' && draft === '' && attachmentCount === 0 && phase === 'plain' && idle && writable

      /* Verify the repaint after it mounts, and drop to the row when it did not land. */
      React.useEffect(() => {
        if (!paints) {
          setSurface('placeholder')
          return
        }
        if (surface === 'row') return
        const dock = anchorRef.current?.closest('[data-composer-dock]')
        const target = dock?.parentElement?.querySelector(PLACEHOLDER)
        const after = target === null || target === undefined ? null : getComputedStyle(target, '::after')
        const painted = after === null ? '' : String(after.content ?? '')
        const sized = after === null ? 0 : Number.parseFloat(after.fontSize)
        const landed = painted !== '' && painted !== 'none' && painted !== 'normal' && painted.includes(suggestion) && sized >= 8
        if (landed) return
        setSurface('row')
        if (warned !== true) {
          warned = true
          console.warn('[composer-predict] the composer placeholder could not be repainted; showing the row instead')
        }
      }, [paints, surface, suggestion])

      /* One diagnostic line per distinct decision, so a silent composer is explainable. */
      const reportRef = React.useRef('')
      React.useEffect(() => {
        const signature = `${key}|${suggestion ?? ''}|${paints}|${draft === ''}|${phase}`
        if (reportRef.current === signature) return
        reportRef.current = signature
        const dock = anchorRef.current?.closest('[data-composer-dock]') ?? document.querySelector('[data-composer-dock]')
        const target = dock?.parentElement?.querySelector(PLACEHOLDER) ?? document.querySelector(PLACEHOLDER)
        const after = target === null || target === undefined ? '' : String(getComputedStyle(target, '::after').content ?? '')
        void sendReport({
          sessionId,
          generation,
          surface,
          paints,
          hasText: typeof suggestion === 'string' && suggestion !== '',
          text: typeof suggestion === 'string' ? suggestion.slice(0, 60) : '',
          draftLength: typeof draft === 'string' ? draft.length : -1,
          phase,
          running,
          blank,
          removed,
          subagentMode,
          placeholderFound: target !== null && target !== undefined,
          afterContent: after.slice(0, 80),
          styleInDom: document.querySelector('style[data-dsh-composer-predict]') !== null,
        })
      }, [anchorRef, blank, draft, generation, key, paints, phase, removed, sessionId, subagentMode, suggestion, surface])

      const accept = React.useCallback(() => {
        if (typeof suggestion !== 'string' || suggestion === '') return
        try {
          inputActions.setDraft(suggestion)
        } catch {
          return
        }
      }, [inputActions, suggestion])

      React.useEffect(() => {
        if (!paints) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Tab' || event.isComposing) return
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (event.defaultPrevented) return
          const dock = anchorRef.current?.closest('[data-composer-dock]')
          if (!dock) return
          const active = document.activeElement
          if (!active || active.isContentEditable !== true) return
          if (!dock.parentElement?.contains(active)) return
          event.preventDefault()
          event.stopPropagation()
          accept()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [accept, paints])

      if (!paints) return null

      if (surface === 'row') {
        return h(
          'div',
          { style: ROW.row, ref: anchorRef },
          h(
            'button',
            {
              type: 'button',
              style: ROW.hint,
              title: `${suggestion} — Tab`,
              onMouseDown: (event) => event.preventDefault(),
              onClick: accept,
            },
            h('span', { style: ROW.text }, suggestion),
          ),
          h(
            'button',
            {
              type: 'button',
              style: ROW.dismiss,
              title: '×',
              'aria-label': '×',
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => setEntry({ key, text: null }),
            },
            '×',
          ),
        )
      }

      return h('style', { ref: anchorRef, 'data-dsh-composer-predict': true }, ghostCss(suggestion))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'composer-predict',
              order: 0,
            },
            PlaceholderPainter,
          ),
        )
      },
    }
  },
})
