/**
 * Marks contract fields that hold personal data: LoggingBehavior masks them in the logs.
 *
 * `@hasPII()` works under both decorator semantics, legacy (experimentalDecorators, which is how
 * the core is built) and standard TC39, in case a consumer compiles the core sources without
 * experimentalDecorators.
 */
const PII_MARKER = Symbol.for('ryadom.core.pii')

interface PiiConfig {
  fullMask: boolean
  regex?: RegExp
}

type PiiMap = Map<string | symbol, PiiConfig>
type WithPii = { [PII_MARKER]?: PiiMap }

function registerPii(prototype: object, key: string | symbol, config: PiiConfig): void {
  const target = prototype as WithPii
  const own = Object.prototype.hasOwnProperty.call(target, PII_MARKER) ? target[PII_MARKER] : undefined
  const map: PiiMap = own ?? new Map(target[PII_MARKER] ?? [])
  map.set(key, config)
  if (!own) Object.defineProperty(target, PII_MARKER, { value: map, enumerable: false })
}

interface FieldDecoratorContextLike {
  kind: string
  name: string | symbol
  addInitializer(initializer: (this: object) => void): void
}

function isDecoratorContext(value: unknown): value is FieldDecoratorContextLike {
  return typeof value === 'object' && value !== null && 'kind' in value && 'addInitializer' in value
}

/** @param fullMask true replaces the whole value (passwords, tokens); false masks it partially (email). */
export function hasPII(fullMask = false, regex?: RegExp) {
  // The signature fits both (prototype, key) and (undefined, context).
  return function (target: unknown, context: unknown): void {
    const config: PiiConfig = { fullMask, regex }
    if (isDecoratorContext(context)) {
      context.addInitializer(function (this: object) {
        registerPii(Object.getPrototypeOf(this) as object, context.name, config)
      })
      return
    }
    registerPii(target as object, context as string | symbol, config)
  }
}

function getPIIConfig(obj: object, key: string): PiiConfig | undefined {
  return (obj as WithPii)[PII_MARKER]?.get(key)
}

export function maskPII(value: unknown, fullMask = false, regex?: RegExp): unknown {
  if (value === null || value === undefined) return value
  if (fullMask) return '***SECRET***'
  if (typeof value === 'string') {
    if (regex) return value.replace(regex, '***')
    if (value.length <= 3) return '***'
    if (value.length <= 6) return `${value.charAt(0)}***${value.charAt(value.length - 1)}`
    return `${value.substring(0, 2)}***${value.substring(value.length - 2)}`
  }
  if (Array.isArray(value)) return value.map((item) => maskPII(item, fullMask, regex))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, maskPII(val, fullMask, regex)]))
  }
  return '***'
}

/** A copy of the object with the fields marked @hasPII masked, recursively. */
export function maskPIIRecursively(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return obj
  if (obj instanceof Date) return obj
  if (Array.isArray(obj)) return obj.map((item) => maskPIIRecursively(item))
  const masked: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const config = getPIIConfig(obj, key)
    masked[key] = config ? maskPII(value, config.fullMask, config.regex) : maskPIIRecursively(value)
  }
  return masked
}
