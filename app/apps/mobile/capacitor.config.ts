import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Live reload from the Vite dev server instead of the bundle in assets, enabled only through an
 * environment variable at `cap sync` time (pnpm android:live). Without it, `server.url` and
 * `cleartext` never reach the generated capacitor.config.json: an HTTP address in a release means
 * both a review rejection and a way to replace the app on an open network.
 */
const liveReloadUrl = process.env.CAP_LIVE_RELOAD_URL

const config: CapacitorConfig = {
  // Permanent: this is the applicationId in the stores and the Java package of the native code.
  // Gradle adds the .dev suffix for the dev flavour.
  appId: 'ru.ryadom.app',
  appName: 'Рядом',
  webDir: 'dist/client',
  backgroundColor: '#00051a',
  server: {
    androidScheme: 'https',
    ...(liveReloadUrl ? { url: liveReloadUrl, cleartext: true } : {}),
  },
  plugins: {
    CapacitorUpdater: {
      // Our own OTA mechanism (/api/app-status + app-update.ts): Capgo's cloud
      // auto-update is off and we manage the bundles ourselves.
      autoUpdate: false,
      // By default the plugin sends update events and JS errors to the Capgo cloud even with
      // auto-update off. An empty string means send nothing.
      statsUrl: '',
    },
    SplashScreen: {
      launchShowDuration: 500,
      launchAutoHide: true,
      backgroundColor: '#00051a',
      showSpinner: false,
    },
    SystemBars: {
      // The app is dark only, so light status bar icons, regardless of the system theme.
      style: 'DARK',
      insetsHandling: 'css',
      // The WebView extends under the system bars (viewport-fit=cover); this hint removes the
      // layout shift at startup.
      initialViewportFitValueHint: 'cover',
    },
    StatusBar: {
      style: 'DARK',
    },
    Keyboard: {
      resize: 'native',
    },
  },
}

export default config
