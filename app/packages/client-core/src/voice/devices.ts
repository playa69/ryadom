/**
 * Which microphone and which speaker the conversation uses, for a person who has more than one: a headset
 * and the laptop's own, an audio interface, a monitor with speakers. Left to itself the browser decides
 * (in its permission prompt or its own settings), and that is often not the device the person talks into.
 *
 * The choice belongs to this browser, not the account: device ids are issued per site and per browser
 * profile. It is kept with the device's name as well, because the id changes when the site's data is
 * cleared, and a headset found by its name is still the person's headset. Each client passes its own
 * storage key (see their storage keys).
 *
 * Names are never reported anywhere: a device is often named after its owner ("AirPods Маши").
 */

export interface AudioDevice {
  /** `MediaDeviceInfo.deviceId`; `SYSTEM_DEVICE_ID` is the browser's own "whatever the system uses". */
  id: string
  label: string
}

/** A device in the list the screen shows. */
export interface AudioDeviceOption extends AudioDevice {
  /** The "as in the system" entry: it follows the system's default when that changes. Its label is the device it points at now. */
  system: boolean
}

export interface AudioDeviceList {
  inputs: AudioDeviceOption[]
  /** Empty where the page cannot choose a speaker (iPhone, Safari, Firefox): the system routes the sound. */
  outputs: AudioDeviceOption[]
  /**
   * What the browser uses when nothing is chosen: the device it lists first. Chrome lists its own
   * preferred one first (set in its prompt or settings), which need not be the system's default.
   */
  browserPick: { input: string | null; output: string | null }
}

/** What the person chose here; null for each kind they never chose, and then the browser decides. */
export interface AudioDeviceChoice {
  input: AudioDevice | null
  output: AudioDevice | null
}

export type AudioDeviceKind = 'input' | 'output'

/** Chromium's entry for "the system's default device"; it follows the system when that changes. */
export const SYSTEM_DEVICE_ID = 'default'
/** Chromium on Windows also lists the system's communications device: a second "default" would only confuse. */
const COMMUNICATIONS_DEVICE_ID = 'communications'

const EMPTY_CHOICE: AudioDeviceChoice = { input: null, output: null }

function isDevice(value: unknown): value is AudioDevice {
  if (typeof value !== 'object' || value === null) return false
  const { id, label } = value as Record<string, unknown>
  return typeof id === 'string' && id !== '' && typeof label === 'string'
}

/** Storage that is missing, refuses or holds something else means no choice. */
export function readAudioDevices(key: string): AudioDeviceChoice {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (typeof stored !== 'object' || stored === null) return EMPTY_CHOICE
    const { input, output } = stored as Record<string, unknown>
    return { input: isDevice(input) ? input : null, output: isDevice(output) ? output : null }
  } catch {
    return EMPTY_CHOICE
  }
}

export function writeAudioDevice(key: string, kind: AudioDeviceKind, device: AudioDevice | null): void {
  const choice = { ...readAudioDevices(key), [kind]: device ? { id: device.id, label: device.label } : null }
  try {
    if (!choice.input && !choice.output) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(choice))
  } catch {
    // Not remembered: the next conversation starts with the browser's device, which is harmless.
  }
}

/**
 * Whether the page can send the agent's voice to a speaker of its choosing. Chromium can (Chrome, Edge,
 * Yandex, Opera, Android WebView); elsewhere the sound goes where the system sends it.
 */
export function canChooseOutput(): boolean {
  return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype
}

/** iPadOS 13+ claims to be a Mac in the UA; the touchscreen, which a Mac lacks, tells them apart. */
function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)
}

/**
 * What `getUserMedia` is asked for to open `deviceId`. iOS routes the microphone together with the speaker
 * and may refuse an exact device it would rather not route to, so there it is a preference.
 */
export function inputConstraint(deviceId: string): ConstrainDOMString {
  return isIos() ? { ideal: deviceId } : { exact: deviceId }
}

function optionsOf(
  devices: readonly MediaDeviceInfo[],
  kind: MediaDeviceKind,
  unnamed: (n: number) => string,
): AudioDeviceOption[] {
  // Before the microphone is allowed the browser hides ids and names: there is nothing to choose from.
  const own = devices.filter(
    (device) =>
      device.kind === kind && device.deviceId !== '' && device.deviceId !== COMMUNICATIONS_DEVICE_ID,
  )
  const real = own.filter((device) => device.deviceId !== SYSTEM_DEVICE_ID)
  const options: AudioDeviceOption[] = real.map((device, index) => ({
    id: device.deviceId,
    label: device.label || unnamed(index + 1),
    system: false,
  }))
  const system = own.find((device) => device.deviceId === SYSTEM_DEVICE_ID)
  if (system) {
    // Its own label is "Default - <name>", worded in the browser's language: the name is taken from the
    // device it shares a group with.
    const target = real.find((device) => device.groupId !== '' && device.groupId === system.groupId)
    options.unshift({
      id: SYSTEM_DEVICE_ID,
      label: target?.label || system.label.replace(/^[^-–]*[-–]\s*/, '') || system.label,
      system: true,
    })
  }
  return options
}

/** The microphones and speakers the page can use right now. Never rejects: a browser that cannot list them has none. */
export async function listAudioDevices(): Promise<AudioDeviceList> {
  let devices: MediaDeviceInfo[] = []
  try {
    devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? []
  } catch {
    // Listing refused: nothing to choose from.
  }
  const first = (kind: MediaDeviceKind) =>
    devices.find(
      (device) =>
        device.kind === kind && device.deviceId !== '' && device.deviceId !== COMMUNICATIONS_DEVICE_ID,
    )?.deviceId ?? null
  const outputs = canChooseOutput()
  return {
    inputs: optionsOf(devices, 'audioinput', (n) => `Микрофон ${n}`),
    outputs: outputs ? optionsOf(devices, 'audiooutput', (n) => `Динамик ${n}`) : [],
    browserPick: { input: first('audioinput'), output: outputs ? first('audiooutput') : null },
  }
}

/**
 * The device to use for a remembered choice: the same id if it is here, otherwise one with the same
 * name (the id changed), otherwise null (it is unplugged or switched off) and the browser decides.
 */
export function resolveAudioDevice(
  choice: AudioDevice | null,
  options: readonly AudioDeviceOption[],
): AudioDeviceOption | null {
  if (!choice) return null
  return (
    options.find((option) => option.id === choice.id) ??
    options.find((option) => !option.system && option.label === choice.label) ??
    null
  )
}

/** Calls `onChange` when a device is plugged in or out. Returns the unsubscribe. */
export function watchAudioDevices(onChange: () => void): () => void {
  const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
  if (!media?.addEventListener) return () => {}
  media.addEventListener('devicechange', onChange)
  return () => media.removeEventListener('devicechange', onChange)
}
