/**
 * The JS version: `<package.json version>.<OTA_BUILD_NUMBER>`, `.0` without a build number.
 *
 * One definition for the OTA archive (its name and the manifest, build-ota-bundle.mjs) and for the
 * version the JS inside it reports to /api/app-status (`__JS_VERSION__`, vite.config.ts). When the two
 * drifted apart, a device that had applied a bundle went on reporting an older version: it was offered
 * the same bundle again and again and saw a rollback as an ordinary background update.
 *
 * At most six digits, because the server accepts no longer segment (`isVersionString`); a bundle whose
 * version the server rejects is worse than a failed build.
 */
export function jsVersion(packageVersion, buildNumber = process.env.OTA_BUILD_NUMBER) {
  const build = (buildNumber ?? '').trim() || '0'
  if (!/^\d{1,6}$/.test(build)) {
    throw new Error(`OTA_BUILD_NUMBER must be 1-6 digits (got "${buildNumber}")`)
  }
  return `${packageVersion}.${build}`
}
