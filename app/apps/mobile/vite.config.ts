import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { jsVersion } from './scripts/js-version.mjs'

/**
 * The app client (src/client). Three build outputs and a dev server:
 *
 * - `vite build --mode web`: the web build, a PWA written to dist/pwa and served by the nginx image
 *   built from the Dockerfile next to this file (the API serves no client);
 * - `vite build --mode prod`: JS for store builds, prod URLs, no env switcher;
 * - `vite build --mode dev`: JS for dev builds, with the env switcher, local by default;
 * - `vite --mode dev`: dev server on http://localhost:5174, with `/api` and the WebSocket proxied
 *   to services/api.
 *
 * Server URLs arrive as process environment variables (in CI, from the repository variables);
 * .env.dev and .env.prod hold empty placeholders. `import.meta.env.MODE === 'web'` and
 * `VITE_FLAVOR === 'dev'` are literal checks written in place: the minifier folds them into a
 * constant and drops the unreachable code, so the env switcher never reaches production.
 */

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// Where the dev server proxies the API. Port 3002 is sometimes taken; then services/api runs on
// another port and that port is named here.
const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3002'

/**
 * PWA tags, web build only: store builds set these themselves through Capacitor and the platform
 * manifest, where extra apple-* tags mean nothing.
 *
 * The two URLs are written here, after Vite has rewritten the asset URLs of index.html, so they are
 * NOT rebased by it: they are built from the resolved `base` (`/` or the prefix the PWA is
 * published under, e.g. `/pwa/`).
 */
function webIndexHtmlPlugin(): Plugin {
  let base = '/'
  return {
    name: 'ryadom-web-index-html',
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: (html) => {
      const tags = [
        `<link rel="manifest" href="${base}manifest.webmanifest">`,
        `<link rel="apple-touch-icon" href="${base}apple-touch-icon-180x180.png">`,
        '<meta name="mobile-web-app-capable" content="yes">',
        '<meta name="apple-mobile-web-app-capable" content="yes">',
        // black-translucent lets content run under the status bar, as in the native build.
        '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
        '<meta name="apple-mobile-web-app-title" content="Рядом">',
      ].join('\n    ')
      return html.replace('</head>', `    ${tags}\n  </head>`)
    },
  }
}

/**
 * The URL prefix of the web build (`PWA_BASE`, e.g. `/pwa`): the PWA is published under it on a
 * host shared with other apps, and every asset URL, the service worker and the manifest are
 * resolved against it. Returns Vite's form, with a slash on both ends; `/` is a host of its own.
 *
 * Only the web build has a prefix. The store builds (`--mode prod|dev`) and the OTA bundle run
 * from the WebView at `https://localhost/` and must keep `/`.
 */
function readWebBase(value: string | undefined): string {
  const trimmed = (value ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (!trimmed) return '/'
  if (!/^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(trimmed)) {
    throw new Error(`PWA_BASE must look like "/pwa" (got "${value}")`)
  }
  return `/${trimmed}/`
}

function pickViteVars(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('VITE_') && value !== undefined) result[key] = value
  }
  return result
}

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...pickViteVars(process.env) }
  const isWeb = mode === 'web'

  if (command === 'build' && !isWeb) {
    if (env.VITE_FLAVOR !== 'dev' && env.VITE_FLAVOR !== 'prod') {
      throw new Error(`VITE_FLAVOR must be "dev" or "prod" (got "${env.VITE_FLAVOR ?? ''}"). Use --mode dev|prod.`)
    }
    if (!env.VITE_PROD_API_URL || !env.VITE_PROD_WEB_URL) {
      console.warn(
        '\n[ryadom] VITE_PROD_API_URL / VITE_PROD_WEB_URL не заданы: среда prod в этой сборке не работает.' +
          '\n       Для локальной проверки это нормально.\n',
      )
    }
  }

  return {
    // Web build only (see readWebBase); the store and OTA builds are served from the WebView root.
    base: isWeb ? readWebBase(process.env.PWA_BASE) : '/',
    plugins: [
      react(),
      isWeb && webIndexHtmlPlugin(),
      // Service worker, web build only. manifest: false because manifest.webmanifest lives in
      // public/ and the plugin must leave it alone.
      isWeb &&
        VitePWA({
          strategies: 'injectManifest',
          srcDir: 'src/sw',
          filename: 'sw.ts',
          injectRegister: false,
          registerType: 'prompt',
          manifest: false,
          includeManifestIcons: false,
          devOptions: { enabled: false },
          injectManifest: {
            // Framework7 CSS is bundled into one large file; otherwise the workbox warning fails the build.
            maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
            // The analytics SDK (~100 kB gzipped) is fetched on demand, and only when the server turned
            // analytics on. Precaching it would make every install download it for nothing. The same goes
            // for the WASM Opus decoder (~67 kB gzipped): only a browser without one of its own (iOS
            // before 26, Firefox on Android) fetches it, when a dialog opens; if it cannot, voice is μ-law.
            globIgnores: ['**/assets/posthog-*.js', '**/assets/opus-decoder-*.js'],
          },
        }),
    ],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      // What the native update check reports and compares: the same version the OTA manifest gives this JS.
      __JS_VERSION__: JSON.stringify(jsVersion(pkg.version)),
      // What analytics report as `app_version`: the image tag (`RELEASE`) when the build has one.
      __RELEASE__: JSON.stringify(process.env.RELEASE?.trim() || pkg.version),
    },
    server: {
      port: 5174,
      strictPort: true,
      // The emulator reaches the host at 10.0.2.2, so the dev server must listen beyond loopback.
      host: true,
      proxy: {
        '/api': { target: API_PROXY_TARGET, changeOrigin: true, ws: true },
      },
    },
    // `vite preview --mode web`: check the PWA build locally without Docker.
    preview: {
      port: 4174,
      proxy: {
        '/api': { target: API_PROXY_TARGET, changeOrigin: true, ws: true },
      },
    },
    build: {
      outDir: isWeb ? 'dist/pwa' : 'dist/client',
      emptyOutDir: true,
      // The WebView on Android 8+ updates through Play, but not for everyone: with no syntax newer
      // than ES2020 the bundle also runs on older Chrome versions.
      target: 'es2020',
      sourcemap: false,
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: {
          // posthog-js and opus-decoder are only ever imported dynamically (packages/analytics/src/browser.ts,
          // packages/client-core/src/voice/opus.ts). Giving each a chunk of its own keeps it out of the main
          // bundle and lets the service worker skip it (see `globIgnores` above).
          manualChunks: (id) => {
            const path = id.replaceAll('\\', '/')
            if (/posthog-js|@posthog/.test(path)) return 'posthog'
            if (/opus-decoder|@wasm-audio-decoders|simple-yenc|@eshaz\/web-worker/.test(path)) return 'opus-decoder'
            return undefined
          },
        },
      },
    },
  }
})
