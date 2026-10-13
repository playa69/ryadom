import '@fontsource-variable/inter/wght.css'
import 'framework7/css/bundle'
import 'framework7-icons/css/framework7-icons.css'
import '@ryadom/design/tokens.css'
import './styles/tokens.css'
import './styles/app.css'

import { startAnalytics, track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import Framework7 from 'framework7/lite-bundle'
import Framework7React from 'framework7-react'
import { createRoot } from 'react-dom/client'
import F7App from './components/F7App'
import { analyticsPlatform } from './lib/analytics'
import { getApiBase, loadEnv } from './lib/env'
import { initSystemBarsStyle } from './lib/native'
import { isAndroid, isIosNative, isNative, isStandalone } from './lib/platform'

/**
 * Client entry point. Inter comes from the @fontsource package, so the app never fetches it from
 * Google Fonts and looks the same with no network.
 */

Framework7.use(Framework7React)

async function start(): Promise<void> {
  // The environment picked in a dev build has to be loaded before the first API request.
  await loadEnv()
  // Not awaited: the app does not wait for analytics, and calls made while it loads are queued. The API
  // address is the environment's, so this is after loadEnv: empty for the web build (the same origin),
  // absolute in a store build, where the WebView's own origin is `https://localhost`.
  void startAnalytics({
    apiBase: getApiBase(),
    platform: analyticsPlatform({ android: isAndroid(), ios: isIosNative(), standalone: isStandalone() }),
    appVersion: __RELEASE__,
  })
  track(AnalyticsEvent.AppOpened, { standalone: isNative() || isStandalone() })
  initSystemBarsStyle()
  const root = document.getElementById('app')
  if (!root) throw new Error('#app not found')
  createRoot(root).render(<F7App />)
}

void start()
