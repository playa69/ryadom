/** Reads the newest six-digit code mailed to an address from Mailpit (the dev mail catcher). */
export async function newestCode(mail, email, notId) {
  const base = mail.replace(/\/$/, '')
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`${base}/api/v1/messages?limit=50`)).json()
    const mine = (list.messages ?? []).find((m) => m.To.some((t) => t.Address.toLowerCase() === email.toLowerCase()) && m.ID !== notId)
    if (mine) {
      const full = await (await fetch(`${base}/api/v1/message/${mine.ID}`)).json()
      const code = `${full.Text ?? ''}\n${full.HTML ?? ''}`.match(/\b(\d{6})\b/)?.[1]
      if (code) return code
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`no code arrived for ${email}`)
}

/** The id of the newest message to an address, so a later read can tell a fresh code from an old one. */
export async function newestId(mail, email) {
  const list = await (await fetch(`${mail.replace(/\/$/, '')}/api/v1/messages?limit=50`)).json()
  return (list.messages ?? []).find((m) => m.To.some((t) => t.Address.toLowerCase() === email.toLowerCase()))?.ID
}
