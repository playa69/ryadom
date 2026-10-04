import { App, Icon, Link, Toolbar, View, Views, f7ready } from 'framework7-react'
import { useEffect } from 'react'
import { RefreshApiErrorCode } from '@ryadom/contracts/api/auth/refresh'
import { ACCOUNT_UNAVAILABLE_EVENT } from '../lib/api'
import { initAppUpdates } from '../lib/app-update'
import { initBackButton, initBackTrap } from '../lib/native'
import { TAB_IDS } from '../lib/nav'
import { isWebBuild } from '../lib/platform'
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
        <button slot="after-inner" type="button" className="rd-rail-sos" onClick={() => openSos()}>
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

  useEffect(() => initAppUpdates(), [])
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

  if (auth.restoring) {
    return (
      <div className="rd-boot" aria-hidden="true">
        <BrandMark size={72} />
      </div>
    )
  }

  if (!auth.isAuthenticated) return <View key="anonymous" main url="/login/" className="safe-areas" />
  return <SignedInViews key="signed-in" />
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
