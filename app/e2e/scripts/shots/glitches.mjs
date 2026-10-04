/**
 * Looks for visual glitches in the page as it is on screen right now, the kind a screenshot would
 * show and a test would not: things sticking out sideways, text cut off, controls lying on top of
 * each other, text printed over text, buttons stretched across the whole window, text hugging the
 * edge, a blank screen. Heuristics, so a finding is a prompt to look, not a verdict: the shots tool
 * prints them next to the picture and a person (or an agent) decides.
 *
 * Runs inside the page (page.evaluate), so it sees exactly what the browser laid out.
 */

export const GLITCH_KINDS = ['overflow-x', 'offscreen', 'clipped-text', 'overlap', 'text-overlap', 'wide-button', 'edge-text', 'blank']

/** @param {import('@playwright/test').Page} page */
export async function findGlitches(page, { fullPage = false, ignore = [] } = {}) {
  const found = await page.evaluate(
    ({ fullPage }) => {
      const out = []
      const root = document.documentElement
      const vw = root.clientWidth
      const vh = window.innerHeight
      const SKIP_AREA = '[aria-hidden="true"], [inert], .sr-only'

      const describe = (el) => {
        const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')
        const text = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 28)
        return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}${text ? ` "${text}"` : ''}`
      }

      /** The rectangle of an element that a person can see, or null (hidden, off screen, covered). */
      const seen = (el) => {
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) return null
        // The visually-hidden pattern (sr-only): a 1px box with clipped content, whatever class produces it.
        for (let p = el; p && p !== document.body; p = p.parentElement) {
          const pr = p.getBoundingClientRect()
          if (pr.width <= 2 && pr.height <= 2 && getComputedStyle(p).position === 'absolute') return null
        }
        const closed = el.closest('details:not([open])')
        if (closed && !el.closest('summary') && el !== closed) return null
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null
        for (let p = el.parentElement; p; p = p.parentElement) {
          const pcs = getComputedStyle(p)
          if (pcs.display === 'none' || pcs.visibility === 'hidden' || Number(pcs.opacity) === 0) return null
        }
        if (fullPage) return r
        if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return null
        const cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1)
        const cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1)
        const top = document.elementFromPoint(cx, cy)
        if (!top || !(el.contains(top) || top.contains(el))) return null
        return r
      }

      const related = (a, b) => a.contains(b) || b.contains(a)
      /** Bars that float over scrolling content (tab bars, sticky headers) lie on top of it by design. */
      const floating = (el) => {
        if (el.closest('.toolbar, .navbar')) return true
        for (let p = el; p && p !== document.body; p = p.parentElement) {
          const pos = getComputedStyle(p).position
          if (pos === 'fixed' || pos === 'sticky') return true
        }
        return false
      }
      /** Text cut by an ellipsis or a clamp: its range still reports the hidden part, so it cannot be measured. */
      const overflows = (el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1
      const truncated = (el) => {
        if (overflows(el)) return true
        // An ellipsis often sits on a wrapper around the link or span that holds the text.
        for (let p = el.parentElement, depth = 0; p && p !== document.body && depth < 3; p = p.parentElement, depth++) {
          const cs = getComputedStyle(p)
          if ((cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none')) && overflows(p)) return true
        }
        return false
      }
      /** One rectangle per line for an inline element that wraps; the bounding box of such an element is a lie. */
      const boxes = (el) => {
        if (getComputedStyle(el).display === 'inline') {
          const rects = [...el.getClientRects()].filter((q) => q.width > 1 && q.height > 1)
          if (rects.length) return rects
        }
        return [el.getBoundingClientRect()]
      }
      const overlapOf = (a, b) => {
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        return w > 0 && h > 0 ? [w, h] : null
      }

      // 1. The page itself is wider than the window.
      const wide = Math.max(root.scrollWidth, document.body.scrollWidth) - vw
      if (wide > 1) out.push({ kind: 'overflow-x', text: `the page is ${wide}px wider than the window` })

      const all = [...document.body.querySelectorAll('*')]

      // 2. Visible things poking out of the window sideways (inside a scroller they are meant to).
      let poking = 0
      for (const el of all) {
        if (poking >= 4) break
        if (el.closest(SKIP_AREA)) continue
        const r = seen(el)
        if (!r) continue
        const outside = r.right > vw + 1 || r.left < -1
        if (!outside) continue
        let scroller = false
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX
          if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') { scroller = true; break }
        }
        if (scroller || getComputedStyle(el).position === 'fixed') continue
        poking++
        out.push({ kind: 'offscreen', text: `${describe(el)} spans ${Math.round(r.left)}..${Math.round(r.right)} in a ${vw}px window` })
      }

      // 4. Controls on top of each other.
      const controls = [...document.querySelectorAll('a[href], button, input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"]')]
        .filter((el) => !el.closest(SKIP_AREA) && !el.matches('.sr-only') )
        .map((el) => ({ el, r: seen(el) }))
        .filter((c) => c.r)
      let stacked = 0
      for (let i = 0; i < controls.length && stacked < 5; i++) {
        for (let j = i + 1; j < controls.length && stacked < 5; j++) {
          const a = controls[i]
          const b = controls[j]
          if (related(a.el, b.el) || floating(a.el) || floating(b.el)) continue
          // An absolutely placed control inside the field next to it (the reveal-password eye) sits there on purpose.
          if (a.el.parentElement === b.el.parentElement && (getComputedStyle(a.el).position === 'absolute' || getComputedStyle(b.el).position === 'absolute')) continue
          let o = null
          for (const qa of boxes(a.el)) for (const qb of boxes(b.el)) o = o ?? (() => { const x = overlapOf(qa, qb); return x && x[0] >= 6 && x[1] >= 6 ? x : null })()
          if (o) {
            stacked++
            out.push({ kind: 'overlap', text: `${describe(a.el)} overlaps ${describe(b.el)} by ${Math.round(o[0])}x${Math.round(o[1])}px` })
          }
        }
      }

      // 5. Text printed over other text or over a control.
      const leaves = all
        .filter((el) => !el.closest(SKIP_AREA) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
        .filter((el) => !el.matches('option, script, style'))
        .map((el) => {
          const rects = []
          for (const node of el.childNodes) {
            if (node.nodeType !== 3 || !node.textContent.trim()) continue
            const range = document.createRange()
            range.selectNodeContents(node)
            rects.push(...[...range.getClientRects()].filter((q) => q.width > 1 && q.height > 1))
          }
          return { el, rects, r: seen(el) }
        })
        .filter((t) => t.r && t.rects.length)
      let printed = 0
      for (let i = 0; i < leaves.length && printed < 5; i++) {
        for (let j = i + 1; j < leaves.length && printed < 5; j++) {
          const a = leaves[i]
          const b = leaves[j]
          if (related(a.el, b.el) || truncated(a.el) || truncated(b.el) || floating(a.el) || floating(b.el)) continue
          const hit = a.rects.some((qa) => b.rects.some((qb) => {
            const o = overlapOf(qa, qb)
            return o && o[0] >= 4 && o[1] >= 4
          }))
          if (hit) {
            printed++
            out.push({ kind: 'text-overlap', text: `${describe(a.el)} is printed over ${describe(b.el)}` })
          }
        }
      }

      // 5b. Text cut off by a box with hidden overflow (an ellipsis or a line clamp is a choice, a cut is a bug).
      let cut = 0
      for (const t of leaves) {
        if (cut >= 4) break
        let box = null
        for (let p = t.el.parentElement; p && p !== document.body; p = p.parentElement) {
          const cs = getComputedStyle(p)
          if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') break
          if (cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflowY === 'hidden' || cs.overflowY === 'clip') { box = p; break }
        }
        if (!box || box === t.el) continue
        const own = getComputedStyle(t.el)
        if (own.textOverflow === 'ellipsis' || (own.webkitLineClamp && own.webkitLineClamp !== 'none')) continue
        if (truncated(t.el)) continue
        const frame = box.getBoundingClientRect()
        const over = Math.max(
          ...t.rects.map((q) => Math.max(frame.left - q.left, q.right - frame.right, frame.top - q.top, q.bottom - frame.bottom)),
        )
        if (over > 2) {
          cut++
          out.push({ kind: 'clipped-text', text: `${describe(t.el)} is cut off by ${describe(box)} (${Math.round(over)}px outside)` })
        }
      }

      // 6. Buttons stretched across a wide window.
      // Only real buttons count (shadcn Button, Framework7 .button): a settings or menu row is meant to be wide.
      const looksLikeButton = (el) => el.matches('[data-slot="button"], .button, .rd-icon-button')
      let stretched = 0
      if (vw >= 700) {
        for (const { el, r } of controls) {
          if (stretched >= 4) break
          if (!looksLikeButton(el) || el.closest('[role="menu"], [role="listbox"]')) continue
          if (r.width > 560 && r.height < 120) {
            stretched++
            out.push({ kind: 'wide-button', text: `${describe(el)} is ${Math.round(r.width)}px wide in a ${vw}px window` })
          }
        }
      }

      // 7. Text hugging the edge of the window.
      let edge = 0
      for (const t of leaves) {
        if (edge >= 3) break
        if (t.el.closest('[role="dialog"], dialog') || truncated(t.el)) continue
        const left = Math.min(...t.rects.map((q) => q.left))
        const right = Math.max(...t.rects.map((q) => q.right))
        if ((left >= 0 && left < 10) || (right <= vw && right > vw - 10 && left > 0)) {
          // Full-bleed bars and the scrollbar gutter are not what this is about.
          const cs = getComputedStyle(t.el)
          if (cs.position === 'fixed' || cs.position === 'sticky') continue
          edge++
          out.push({ kind: 'edge-text', text: `${describe(t.el)} sits ${Math.round(left < 10 ? left : vw - right)}px from the window edge` })
        }
      }

      // 8. A screen with nothing on it.
      if (document.body.innerText.trim().length < 5) out.push({ kind: 'blank', text: 'the page has no visible text' })

      return out
    },
    { fullPage },
  )
  return found.filter((g) => !ignore.includes(g.kind))
}
