export interface OutgoingEmail {
  from: string
  to: string
  subject: string
  html: string
  text: string
}

export interface EmailTransport {
  send(email: OutgoingEmail): Promise<{ messageId: string }>
}
