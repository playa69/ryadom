/**
 * Names of the browser and the system out of a `User-Agent`, for the list of a person's sessions.
 * A handful of patterns for what our people really use, not a parser of every agent there is: the
 * result is a label to recognise one's own device by, and an agent that matches nothing gets `null`
 * and an honest "unknown device" on screen.
 */

export interface UserAgentNames {
  browser: string | null
  os: string | null
}

// The order matters: most browsers also say "Chrome" and "Safari", and Edge, Opera and the others
// say what they are on top of that.
const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|OPiOS)\//, 'Opera'],
  [/\bYaBrowser\//, 'Яндекс Браузер'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
]

// iOS first: an iPhone's agent also says "like Mac OS X", and an Android one says "Linux".
const SYSTEMS: readonly [RegExp, string][] = [
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\b(?:Macintosh|Mac OS X)\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
]

function firstMatch(table: readonly [RegExp, string][], userAgent: string): string | null {
  for (const [pattern, name] of table) if (pattern.test(userAgent)) return name
  return null
}

export function describeUserAgent(userAgent: string | null): UserAgentNames {
  if (!userAgent) return { browser: null, os: null }
  return { browser: firstMatch(BROWSERS, userAgent), os: firstMatch(SYSTEMS, userAgent) }
}
