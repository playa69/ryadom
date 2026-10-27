/**
 * The client web build (PWA) and the image that serves it (apps/mobile/Dockerfile, nginx).
 *
 * One image serves both the local stack and prod, so the website address is not baked into the build: the
 * image's entrypoint (apps/mobile/nginx/entrypoint.sh) inserts this meta tag before `</head>` of
 * `index.html` every time the container starts. The entrypoint spells the name out, so a change here
 * has to be repeated there.
 */
export enum PwaMeta {
  /** `PUBLIC_WEB_URL`: legal documents and anything "on the website". */
  WebUrl = 'ryadom-web-url',
}

/**
 * URL parameters used when the web build launches. `open` is the app screen to open after the
 * session is restored, for example from a notification once notifications exist.
 */
export enum PwaLaunchParam {
  Open = 'open',
}
