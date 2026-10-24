/** Проигрывание короткого сэмпла голоса из `/voice-samples/<id>.mp3` (по файлу на голос из `@ryadom/contracts/voices`). */
let current: HTMLAudioElement | null = null

export function stopVoiceSample(): void {
  current?.pause()
  current = null
}

/**
 * Проигрывает сэмпл голоса, прерывая прежний; `onEnd` вызывается и при остановке, и при ошибке.
 * `baseUrl` — where the app is published, with a trailing slash (`/app/` for the web app, `import.meta.env.BASE_URL` for the PWA):
 * the samples sit in the app's own `public/`, so under a prefix the root path would reach another site.
 */
export function playVoiceSample(id: string, onEnd: () => void, baseUrl = '/'): void {
  stopVoiceSample()
  const audio = new Audio(`${baseUrl}voice-samples/${id}.mp3`)
  current = audio
  const done = () => {
    if (current === audio) current = null
    onEnd()
  }
  audio.addEventListener('ended', done)
  audio.addEventListener('pause', done)
  audio.addEventListener('error', done)
  void audio.play().catch(done)
}
