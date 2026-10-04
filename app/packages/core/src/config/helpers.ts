import type { BaseServerEnv } from './env'
// The disposable domain list comes from the npm package `disposable-email-domains` (MIT) and is
// copied into the sources as a file instead of being added as a dependency: the package is bare
// CJS whose `main` points straight at the JSON without `"type": "module"`, so a plain `import`
// fails at Node runtime (`ERR_IMPORT_ATTRIBUTE_MISSING`). A local relative JSON does not fail and
// is bundled statically by esbuild/Next. Update it by hand:
// `cp node_modules/disposable-email-domains/index.json src/config/disposable-email-domains.json`.
import disposableEmailDomains from './disposable-email-domains.json'

/** Input rules: applications check them before calling the core, and the core checks again (throws). */
export const AUTH_RULES = {
  emailMaxLength: 254,
  passwordMinLength: 8,
  passwordMaxLength: 128,
  nameMaxLength: 64,
} as const

type EnvOf<K extends keyof BaseServerEnv> = Pick<BaseServerEnv, K>

/**
 * An admin is an email from ADMIN_EMAILS (case-insensitive). Admin rights cannot be granted to a
 * user: only the config defines them. Checked both when a sign-in code is issued and
 * on every request to the admin panel.
 */
export function isAdminEmail(env: EnvOf<'ADMIN_EMAILS'>, email: string): boolean {
  return env.ADMIN_EMAILS.includes(email.trim().toLowerCase())
}

const DISPOSABLE_EMAIL_DOMAINS = new Set<string>(disposableEmailDomains)

/**
 * Disposable email (mailinator.com, temp-mail.org and the like) by the `disposable-email-domains`
 * list. Checked where an address becomes the email of an account, that is at sign-up. Not at
 * sign-in, where the address belongs to an account that already exists.
 */
export function isDisposableEmailDomain(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
  return DISPOSABLE_EMAIL_DOMAINS.has(domain)
}

export type EmailTransportConfig =
  | { kind: 'smtp'; host: string; port: number; secure: boolean; auth?: { user: string; pass: string } }
  | { kind: 'console' }
  | { kind: 'memory' }

/** Email transport settings from env (the schema already guaranteed the required fields). */
export function emailTransportConfig(
  env: EnvOf<'EMAIL_TRANSPORT' | 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_USER' | 'SMTP_PASSWORD' | 'SMTP_SECURE'>,
): EmailTransportConfig {
  switch (env.EMAIL_TRANSPORT) {
    case 'smtp': {
      const port = env.SMTP_PORT ?? 1025
      return {
        kind: 'smtp',
        host: env.SMTP_HOST ?? 'localhost',
        port,
        secure: env.SMTP_SECURE ?? port === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } : undefined,
      }
    }
    case 'console':
      return { kind: 'console' }
    case 'memory':
      return { kind: 'memory' }
  }
}
