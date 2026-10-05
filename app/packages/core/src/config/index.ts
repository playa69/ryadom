// Core configuration. A side-effect-free module: env is read only when getEnv/loadEnv is called.
export {
  baseServerEnvSchema,
  adminEnvSchema,
  appEnvSchema,
  coreEnvSchema,
  loadEnv,
  getEnv,
  resetEnvCache,
  EnvValidationError,
  LOG_LEVELS,
  EMAIL_TRANSPORTS,
  type BaseServerEnv,
  type AdminEnv,
  type AppEnv,
  type CoreEnv,
} from './env'
export {
  AUTH_RULES,
  isAdminEmail,
  isDisposableEmailDomain,
  emailTransportConfig,
  type EmailTransportConfig,
} from './helpers'
export {
  emailInputSchema,
  passwordInputSchema,
  nameInputSchema,
  codeInputSchema,
  deviceIdInputSchema,
  deviceKeyInputSchema,
  consentVersionInputSchema,
} from './input-schemas'
