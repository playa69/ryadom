#!/usr/bin/env node
/**
 * Redraws the PWA icons in apps/mobile/public from the brand mark, on the night-sky background
 * (palette from packages/design). Kept here because this workspace already ships a browser:
 * Chromium renders the SVG, so there is no image library to add just for five files.
 *
 * Usage: node e2e/scripts/pwa-icons.mjs
 */
import { chromium } from '@playwright/test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'mobile', 'public')

const MARK = `<circle cx="26" cy="32" r="12" fill="none" stroke="#f1f4ff" stroke-width="4"/>
<circle cx="43" cy="32" r="7" fill="none" stroke="#2e8fff" stroke-width="4"/>`

const background = (rx) => `<defs>
  <radialGradient id="teal" cx="30%" cy="12%" r="70%"><stop offset="0" stop-color="#2296a8" stop-opacity=".6"/><stop offset="1" stop-color="#2296a8" stop-opacity="0"/></radialGradient>
  <radialGradient id="indigo" cx="95%" cy="100%" r="85%"><stop offset="0" stop-color="#493dd1" stop-opacity=".7"/><stop offset="1" stop-color="#493dd1" stop-opacity="0"/></radialGradient>
</defs>
<rect width="64" height="64" rx="${rx}" fill="#00051a"/>
<rect width="64" height="64" rx="${rx}" fill="url(#teal)"/>
<rect width="64" height="64" rx="${rx}" fill="url(#indigo)"/>`

// [file, size, corner radius in the 64-unit grid, transparent outside the corners]
// The apple and maskable icons are full-bleed squares: the system applies its own mask.
const ICONS = [
  ['favicon-32x32.png', 32, 14, true],
  ['pwa-192x192.png', 192, 14, true],
  ['pwa-512x512.png', 512, 14, true],
  ['apple-touch-icon-180x180.png', 180, 0, false],
  ['maskable-icon-512x512.png', 512, 0, false],
]

const browser = await chromium.launch()
const page = await browser.newPage()

for (const [file, size, rx, transparent] of ICONS) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${background(rx)}${MARK}</svg></body></html>`,
  )
  await page.screenshot({
    path: join(publicDir, file),
    omitBackground: transparent,
    clip: { x: 0, y: 0, width: size, height: size },
  })
  console.log(file)
}

await browser.close()
