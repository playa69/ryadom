import { expect, type BrowserContext, type Page } from '@playwright/test'
import { AGENT_URL } from '../playwright.config'

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
  const response = await fetch(`${AGENT_URL}/dev/tts`, {
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

/**
 * How the voice screen takes turns in this context. Hands-free is the product's default, but Chrome's
 * fake microphone only beeps (20 ms every half a second), which never makes a turn: so the suite runs
 * tap-to-talk, the fallback the setting turns on, and the hands-free scenarios (`test.use({ handsFree:
 * true })`) get a microphone the test speaks into instead, a 220 Hz tone switched with `speakIntoMic`.
 */
export async function installMicrophone(context: BrowserContext, handsFree: boolean): Promise<void> {
  if (!handsFree) {
    await context.addInitScript(() => {
      try {
        localStorage.setItem('ryadom.web.hands-free', 'off')
        localStorage.setItem('ryadom.handsFree', 'off')
      } catch {
        // A page without storage (about:blank) has no voice screen either.
      }
    })
    return
  }
  await context.addInitScript(() => {
    const mic = { on: false, gains: [] as GainNode[], since: 0 }
    ;(window as unknown as { __mic: typeof mic }).__mic = mic
    if (!navigator.mediaDevices) return
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext()
      await audio.resume()
      const tone = audio.createOscillator()
      tone.frequency.value = 220
      const gain = audio.createGain()
      gain.gain.value = mic.on ? 0.5 : 0
      const out = audio.createMediaStreamDestination()
      tone.connect(gain).connect(out)
      tone.start()
      mic.gains.push(gain)
      return out.stream
    }
  })
}

type Mic = { on: boolean; gains: GainNode[]; since: number }

/** The person starts or stops talking into the microphone of a hands-free context. */
export async function speakIntoMic(page: Page, on: boolean): Promise<void> {
  await page.evaluate((value) => {
    const mic = (window as unknown as { __mic: Mic }).__mic
    mic.on = value
    mic.since = performance.now()
    for (const gain of mic.gains) gain.gain.value = value ? 0.5 : 0
  }, on)
}

/**
 * Starts talking into the microphone and returns the milliseconds until the hint under the sphere reads
 * `hint`. Watches before speaking, so the change is never missed between two polls.
 */
export async function speakAndTime(page: Page, hint: string): Promise<number> {
  return page.evaluate(
    (text) =>
      new Promise<number>((resolve) => {
        const mic = (window as unknown as { __mic: Mic }).__mic
        const target = document.querySelector('[data-testid="voice-hint"], .rd-voice-hint')!
        const observer = new MutationObserver(() => {
          if (target.textContent?.trim() !== text) return
          observer.disconnect()
          resolve(performance.now() - mic.since)
        })
        observer.observe(target, { childList: true, characterData: true, subtree: true })
        mic.on = true
        mic.since = performance.now()
        for (const gain of mic.gains) gain.gain.value = 0.5
      }),
    hint,
  )
}
