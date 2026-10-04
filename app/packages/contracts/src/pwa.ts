/**
 * The client web build (PWA) and the application that serves it.
 *
 * One image serves both staging and prod, so environment settings are not baked into the build: the
 * server injects meta tags before `</head>` every time it serves `index.html`.
 */
export enum PwaMeta {
  /** `PUBLIC_WEB_URL`: legal documents and anything "on the website". */
  WebUrl = 'ryadom-web-url',
  /** `APP_ENV`: how the client tells staging from prod. */
  AppEnv = 'ryadom-app-env',
}

/**
 * URL parameters used when the web build launches. `open` is the app screen to open after the
 * session is restored, for example from a notification once notifications exist.
 */
export enum PwaLaunchParam {
  Open = 'open',
}
