import { THEME_STORAGE_KEY } from '@ryadom/client-core/theme'

/*
 * The inline script that applies the theme before the first paint. It must be self-contained: it
 * runs ahead of the JS bundle, so the schedule of client-core/theme (light inside [07:00, 22:00)
 * local, dark otherwise) is restated here — theme-boot.test.ts holds the two in step. The storage
 * key is interpolated from client-core, so it cannot drift. The system palette is never read.
 *
 * Stylesheets in <head> are render-blocking, so by the time this runs in <body> the palette is
 * readable and the browser chrome color can follow the actual tokens, whatever literal they use.
 */
export const THEME_BOOT = `(function () {
  try {
    var root = document.documentElement
    var choice = null
    try {
      choice = window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})
    } catch (e) {}
    var hour = new Date().getHours()
    var theme =
      choice === 'light' || choice === 'dark' ? choice : hour >= 7 && hour < 22 ? 'light' : 'dark'
    if (theme === 'light') root.setAttribute('data-theme', 'light')
    else root.removeAttribute('data-theme')
    root.classList.toggle('dark', theme === 'dark')
    root.style.colorScheme = theme
    var paper = getComputedStyle(root).getPropertyValue('--ryadom-paper').trim()
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta && paper) meta.setAttribute('content', paper)
    var scheme = document.querySelector('meta[name="color-scheme"]')
    if (scheme) scheme.setAttribute('content', theme)
  } catch (e) {}
})()`
