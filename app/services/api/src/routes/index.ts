import type { Hono } from 'hono'
import type { AppEnv, RouteDeps } from '../lib/context'
import { analyticsRoutes } from './analytics'
import { appStatusRoutes } from './app-status'
import { confirmEmailRoutes } from './auth/confirm-email'
import { consentsRoutes } from './auth/consents'
import { deviceRoutes } from './auth/device'
import { forgotPasswordRoutes } from './auth/forgot-password'
import { linkEmailRoutes } from './auth/link-email'
import { loginRoutes } from './auth/login'
import { logoutRoutes } from './auth/logout'
import { meRoutes } from './auth/me'
import { passwordRoutes } from './auth/password'
import { refreshRoutes } from './auth/refresh'
import { registerRoutes } from './auth/register'
import { resendConfirmationRoutes } from './auth/resend-confirmation'
import { resetPasswordRoutes } from './auth/reset-password'
import { sessionsRoutes } from './auth/sessions'
import { dialogsRoutes } from './dialogs'
import { healthRoutes } from './health'
import { memoryRoutes } from './memory'
import { otaBundleRoutes } from './ota-bundle'

/** Every route of the application. The contracts live in src/shared/api. */
export function registerAllRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  healthRoutes(app, deps)
  appStatusRoutes(app, deps)
  analyticsRoutes(app, deps)
  otaBundleRoutes(app, deps)

  registerRoutes(app, deps)
  confirmEmailRoutes(app, deps)
  resendConfirmationRoutes(app, deps)
  loginRoutes(app, deps)
  deviceRoutes(app, deps)
  linkEmailRoutes(app, deps)
  refreshRoutes(app, deps)
  logoutRoutes(app, deps)
  sessionsRoutes(app, deps)
  meRoutes(app, deps)
  consentsRoutes(app, deps)
  passwordRoutes(app, deps)
  forgotPasswordRoutes(app, deps)
  resetPasswordRoutes(app, deps)

  dialogsRoutes(app, deps)
  memoryRoutes(app, deps)
}
