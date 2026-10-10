import { App, Icon, Link, Toolbar, View, Views, f7ready } from 'framework7-react'
import { useEffect, useState } from 'react'
import { RefreshApiErrorCode } from '@ryadom/contracts/api/auth/refresh'
import { POLICY_VERSION } from '@ryadom/contracts/api/policy'
import { ACCOUNT_UNAVAILABLE_EVENT, deviceLogin, getCurrentUser, hasDevice } from '../lib/api'
import { initAppUpdates } from '../lib/app-update'
import { initBackButton, initBackTrap } from '../lib/native'
import { TAB_IDS } from '../lib/nav'
import { isWebBuild } from '../lib/platform'
import { initScreenTracking } from '../lib/screen-tracking'
import { AuthProvider, useAuth } from '../lib/store'
import AppUpdateGate from './AppUpdateGate'
import { BrandMark } from './Brand'
import InstallBanner from './InstallBanner'
import OfflineBar from './OfflineBar'
import { routes } from './routes'
import SosSheet, { openSos } from './SosSheet'

/**
 * The app root: Framework7 (the md theme gives one layout on every platform, and the dark palette
 * comes from the tokens), either the sign-in screen or the tabs, plus the global listeners.
 *
 * The two trees are swapped by key, so the previous session's tabs cannot survive a sign-out.
 */

const f7params = {
  name: 'Рядом',
  theme: 'md' as const,
  /*
   * Framework7's own dark mode. Without it, it derives dozens of chrome surfaces (lists, popovers,
   * sheets, cards) from the accent color and ends up with cream panels on a dark background. Our
   * values from tokens.css override it, because tokens.css is loaded after its styles.
   */
  darkMode: true,
  colors: { primary: '#007aff' },
  routes,
  dialog: {
    buttonOk: 'ОК',
    buttonCancel: 'Отмена',
    preloaderTitle: 'Секунду…',
    progressTitle: 'Секунду…',
  },
  toast: { closeTimeout: 3000 },
  view: {
    // On Android 10+ the system owns the edge-swipe back gesture.
    mdSwipeBack: false,
  },
}

const TABS = [
  { id: TAB_IDS.home, url: '/home/', label: 'Главная', icon: 'house', iconActive: 'house_fill' },
  { id: TAB_IDS.journal, url: '/journal/', label: 'Журнал', icon: 'book', iconActive: 'book_fill' },
  {
    id: TAB_IDS.profile,
    url: '/profile/',
    label: 'Профиль',
    icon: 'person_crop_circle',
    iconActive: 'person_crop_circle_fill',
  },
]

function SignedInViews() {
  return (
    <Views tabs className="safe-areas">
      <Toolbar tabbar icons bottom id="rd-tabbar">
        {/* Rail-only (from 700px, see app.css): the mark on top and SOS at the bottom. On a wide
            screen SOS lives here instead of on each page, so it is on every signed-in screen
 and there is exactly one of it. */}
        <div slot="before-inner" className="rd-rail-brand" aria-hidden="true">
          <BrandMark size={40} />
        </div>
        <button slot="after-inner" type="button" className="rd-rail-sos ph-no-capture" onClick={() => openSos({ source: 'menu' })}>
          <Icon f7="phone_fill" size={20} />
          SOS
        </button>
        {TABS.map((tab) => (
          <Link
            key={tab.id}
            tabLink={`#${tab.id}`}
            tabLinkActive={tab.id === TAB_IDS.home}
            iconF7={tab.icon}
            text={tab.label}
          />
        ))}
      </Toolbar>
      {TABS.map((tab) => (
        <View
          key={tab.id}
          id={tab.id}
          tab
          main={tab.id === TAB_IDS.home}
          tabActive={tab.id === TAB_IDS.home}
          url={tab.url}
          initRouterOnTabShow={tab.id !== TAB_IDS.home}
        />
      ))}
    </Views>
  )
}

function Shell() {
  const { auth, logout } = useAuth()
  const gate = useConsentGate()

  useEffect(() => initAppUpdates(), [])
  useEffect(() => initScreenTracking(), [])
  useEffect(() => initBackButton(), [])
  useEffect(() => initBackTrap(), [])

  // The server ended the session: the account was deleted or blocked. Send the person back to
  // sign-in with a clear explanation, otherwise the screen is left holding empty data.
  useEffect(() => {
    function handleAccountUnavailable(event: Event) {
      const detail = (event as CustomEvent<{ code: RefreshApiErrorCode }>).detail
      void logout()
      f7ready((f7) => {
        f7.dialog.alert(
          detail?.code === RefreshApiErrorCode.ACCOUNT_DELETED
            ? 'Этот аккаунт удалён, поэтому мы вышли из него на этом устройстве.'
            : 'Этот аккаунт заблокирован, поэтому мы вышли из него на этом устройстве.',
          'Вход невозможен',
        )
      })
    }
    window.addEventListener(ACCOUNT_UNAVAILABLE_EVENT, handleAccountUnavailable)
    return () => window.removeEventListener(ACCOUNT_UNAVAILABLE_EVENT, handleAccountUnavailable)
  }, [logout])

  if (auth.restoring) return <BootSplash />

  if (!auth.isAuthenticated) return <AnonymousEntry key="anonymous" />
  if (gate === 'checking') return <BootSplash />
  // The terms need agreeing to (a new account, or a newer version): the first screen takes the person through.
  if (gate === 'needed') return <View key="consent" main url="/welcome/" className="safe-areas" />
  return <SignedInViews key="signed-in" />
}

function BootSplash() {
  return (
    <div className="rd-boot" aria-hidden="true">
      <BrandMark size={72} />
    </div>
  )
}

/**
 * Where a person without a session lands. A phone that already has an anonymous identity is signed
 * back in without a screen: that is an account with no password to ask for. Anyone else sees the
 * first screen if they are new, or the sign-in if they have had an account and left it.
 */
function AnonymousEntry() {
  const { auth, login } = useAuth()
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (await hasDevice()) {
        try {
          // The agreements were given when the account was made; the gate asks again if a newer
          // version of the terms is out.
          const { user, tokens } = await deviceLogin()
          if (cancelled) return
          await login(user, tokens)
          return
        } catch {
          // The server does not answer or does not accept the key: the screens below are fine to land on.
        }
      }
      if (!cancelled) setChecking(false)
    })()
    return () => {
      cancelled = true
    }
  }, [login])

  if (checking) return <BootSplash />
  return <View main url={auth.entry === 'login' ? '/login/' : '/welcome/'} className="safe-areas" />
}

/**
 * Whether the signed-in account has agreed to the current terms. The answer is cached in the stored
 * user, so an account that has agreed costs no request on later launches. When the check cannot be
 * made (no network) the app opens anyway: the server refuses a conversation without the agreement.
 */
function useConsentGate(): 'checking' | 'needed' | 'ok' {
  const { auth, updateUser } = useAuth()
  const userId = auth.user?.id ?? null
  const agreed = auth.user?.consentVersion === POLICY_VERSION
  const [verdict, setVerdict] = useState<'checking' | 'needed' | 'unchecked'>('checking')

  useEffect(() => {
    if (!auth.isAuthenticated || !userId || agreed) return
    let cancelled = false
    setVerdict('checking')
    getCurrentUser()
      .then((me) => {
        if (cancelled) return
        if (me.consentsCompleted && me.consentVersion === POLICY_VERSION) {
          updateUser({ consentVersion: me.consentVersion })
        } else {
          setVerdict('needed')
        }
      })
      .catch(() => {
        if (!cancelled) setVerdict('unchecked')
      })
    return () => {
      cancelled = true
    }
  }, [auth.isAuthenticated, userId, agreed, updateUser])

  if (!auth.isAuthenticated || agreed || verdict === 'unchecked') return 'ok'
  return verdict
}

export default function F7App() {
  return (
    <App {...f7params}>
      <AuthProvider>
        <Shell />
        <AppUpdateGate />
        <OfflineBar />
        <SosSheet />
        {isWebBuild() && <InstallBanner />}
      </AuthProvider>
    </App>
  )
}
