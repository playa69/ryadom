/** A rendered email: subject, HTML and plain-text version (for clients without HTML and for tests). */
export interface RenderedEmail {
  subject: string
  html: string
  text: string
}
