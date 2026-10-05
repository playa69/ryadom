import ConfirmEmailPage from './pages/auth/ConfirmEmailPage'
import ForgotPasswordPage from './pages/auth/ForgotPasswordPage'
import LoginPage from './pages/auth/LoginPage'
import RegisterPage from './pages/auth/RegisterPage'
import ResetPasswordPage from './pages/auth/ResetPasswordPage'
import WelcomePage from './pages/auth/WelcomePage'
import DialogPage from './pages/dialog/DialogPage'
import HomePage from './pages/home/HomePage'
import JournalEntryPage from './pages/journal/JournalEntryPage'
import JournalPage from './pages/journal/JournalPage'
import PeoplePage from './pages/people/PeoplePage'
import ChangePasswordPage from './pages/profile/ChangePasswordPage'
import DeleteAccountPage from './pages/profile/DeleteAccountPage'
import LinkEmailPage from './pages/profile/LinkEmailPage'
import ProfilePage from './pages/profile/ProfilePage'
import SessionsPage from './pages/profile/SessionsPage'

/** Framework7 routes, shared by every View: each tab keeps its own history. */
export const routes = [
  // no session (the first screen is also the gate for terms that need agreeing to again)
  { path: '/welcome/', component: WelcomePage },
  { path: '/login/', component: LoginPage },
  { path: '/register/', component: RegisterPage },
  { path: '/confirm-email/', component: ConfirmEmailPage },
  { path: '/forgot-password/', component: ForgotPasswordPage },
  { path: '/reset-password/', component: ResetPasswordPage },

  // tabs
  { path: '/home/', component: HomePage },
  { path: '/journal/', component: JournalPage },
  { path: '/journal/:dialogId/', component: JournalEntryPage },
  { path: '/profile/', component: ProfilePage },
  { path: '/profile/change-password/', component: ChangePasswordPage },
  { path: '/profile/link-email/', component: LinkEmailPage },
  { path: '/profile/sessions/', component: SessionsPage },
  { path: '/profile/delete/', component: DeleteAccountPage },

  // conversation and people, opened from any tab
  { path: '/dialog/:dialogId/', component: DialogPage },
  { path: '/people/', component: PeoplePage },
]
