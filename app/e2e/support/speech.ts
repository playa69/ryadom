import { expect, type BrowserContext, type Page } from '@playwright/test'

/**
 * The sphere's own voice (client-core/voice/speech) uses the browser's speech synthesis. A headless
 * browser has no voice, and a real engine would make the pace of every test depend on the machine, so
 * every page gets a stand-in that records what it was asked to say and reports the end a moment later.
 */
export async function installSpeechStub(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const spoken: string[] = []
    ;(window as unknown as { __spoken: string[] }).__spoken = spoken

    class Utterance {
      lang = ''
      rate = 1
      voice: unknown = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      onboundary: (() => void) | null = null
      constructor(public text: string) {}
    }
    // The agent's own voice: every buffer scheduled on the player is a piece of its speech that will be heard.
    ;(window as unknown as { __played: number }).__played = 0
    const start = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
      ;(window as unknown as { __played: number }).__played += 1
      return start.apply(this, args)
    }

    const synthesis = {
      speak(utterance: Utterance) {
        // The empty word is the silent unlock of a tap, not speech.
        if (utterance.text) spoken.push(utterance.text)
        setTimeout(() => utterance.onend?.(), 20)
      },
      cancel() {},
      getVoices: () => [],
    }
    Object.defineProperty(window, 'speechSynthesis', { value: synthesis, configurable: true })
    ;(window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = Utterance
  })
}

/** How many pieces of the agent's own speech the player has taken so far (each is 200 ms). */
export function playedBy(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __played?: number }).__played ?? 0)
}

/**
 * Switches the agent mock between real speech (`auto`) and text only (`none`), the way an agent whose
 * speech is down behaves. Dev control of the mock, not part of the agent contract.
 */
export async function setAgentSpeech(mode: 'auto' | 'none'): Promise<void> {
  const base = process.env.E2E_AGENT_URL ?? 'http://127.0.0.1:8081'
  const response = await fetch(`${base}/dev/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
  if (!response.ok) throw new Error(`agent mock refused the speech mode: ${response.status}`)
}

/** What the page has been asked to say so far, sentence by sentence, in order. */
export function spokenBy(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __spoken?: string[] }).__spoken ?? [])
}

/**
 * The page has said exactly these sentences, in this order. Sentences are what the engine is given,
 * so a text is compared as the words that make it up, whatever the split.
 */
export async function expectSpoken(page: Page, ...texts: string[]): Promise<void> {
  const squash = (value: string) => value.replace(/\s+/g, ' ').trim()
  await expect
    .poll(async () => squash((await spokenBy(page)).join(' ')), { message: 'что произнёс шар' })
    .toBe(squash(texts.join(' ')))
}
