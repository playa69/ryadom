import { Worker } from 'node:worker_threads'

/**
 * Worker threads that encode the agent's speech to Opus (opus-worker.ts), so the main thread, which
 * carries every open dialog's sockets, never spends its time in the codec.
 *
 * A speech is a stream pinned to one worker, because its encoder lives there; a worker handles its
 * messages one at a time, so the frames of a stream come back in the order they went in. The workers
 * start on the first Opus speech, not with the process: a pod that sends no Opus pays nothing.
 *
 * One worker is plenty for now: at complexity 5 the WASM encoder takes about 9 ms per second of speech,
 * so a single thread keeps up with some fifty dialogs speaking at once at the agent's double pace,
 * and the pod has one CPU. A worker that dies fails its pending jobs (those speeches lose the rest of
 * their audio, the text is unaffected) and is replaced on the next speech.
 */

export type OpusRequest =
  | { kind: 'open'; stream: number; sampleRate: number; bitrate: number; complexity: number }
  /** `pcm` is PCM16, little-endian; it is transferred, not copied. */
  | { kind: 'encode'; stream: number; job: number; pcm: ArrayBuffer }
  /** The end of the speech: the tail under one packet, padded, and the stream is closed. */
  | { kind: 'finish'; stream: number; job: number }
  | { kind: 'close'; stream: number }

/** `body`: length-prefixed packets, null when there was no whole packet to send. */
export interface OpusReply {
  job: number
  body: ArrayBuffer | null
  error?: string
}

export interface OpusSettings {
  sampleRate: number
  bitrate: number
  complexity: number
}

/** One speech: its frames go in one at a time and come back in the same order. */
export interface OpusStream {
  /** The length-prefixed packets of one frame of PCM16, or null when no whole packet was ready yet. */
  encode(pcm: Uint8Array): Promise<Buffer | null>
  /** The end of the speech: the tail, padded to a packet, or null when there was none. Closes the stream. */
  finish(): Promise<Buffer | null>
  /** Drops the stream: whatever was not encoded yet never will be. */
  close(): void
}

const POOL_SIZE = 1

/**
 * The bundle (build.mjs) puts the worker next to dist/index.js as opus-worker.js; in development and
 * tests this module runs from its source, and Node runs the worker's TypeScript as is.
 */
const WORKER_URL = new URL(
  import.meta.url.endsWith('.ts') ? './opus-worker.ts' : './opus-worker.js',
  import.meta.url,
)

interface Job {
  resolve(body: Buffer | null): void
  reject(error: Error): void
}

class PoolWorker {
  private readonly worker: Worker
  private readonly jobs = new Map<number, Job>()
  private nextJob = 0
  /** Streams open on this worker: the pool gives a new speech to the least busy one. */
  streams = 0
  alive = true

  constructor() {
    this.worker = new Worker(WORKER_URL)
    // An idle encoder must not keep the process from exiting.
    this.worker.unref()
    this.worker.on('message', (reply: OpusReply) => {
      const job = this.jobs.get(reply.job)
      if (!job) return
      this.jobs.delete(reply.job)
      if (reply.error) job.reject(new Error(`opus: ${reply.error}`))
      else job.resolve(reply.body ? Buffer.from(reply.body) : null)
    })
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', (code) => this.fail(new Error(`opus worker exited with code ${code}`)))
  }

  private fail(error: Error): void {
    this.alive = false
    for (const job of this.jobs.values()) job.reject(error)
    this.jobs.clear()
  }

  post(request: OpusRequest, transfer: ArrayBuffer[] = []): void {
    if (this.alive) this.worker.postMessage(request, transfer)
  }

  /** A request that is answered: its reply resolves the promise, in the order the requests went in. */
  ask(build: (job: number) => OpusRequest, transfer: ArrayBuffer[] = []): Promise<Buffer | null> {
    if (!this.alive) return Promise.reject(new Error('opus worker is gone'))
    const job = this.nextJob++
    return new Promise((resolve, reject) => {
      this.jobs.set(job, { resolve, reject })
      this.worker.postMessage(build(job), transfer)
    })
  }

  terminate(): Promise<number> {
    this.alive = false
    return this.worker.terminate()
  }
}

export class OpusPool {
  private workers: PoolWorker[] = []
  private nextStream = 0

  constructor(private readonly size = POOL_SIZE) {}

  /** The least busy live worker; dead ones are replaced here. */
  private pick(): PoolWorker {
    this.workers = this.workers.filter((worker) => worker.alive)
    while (this.workers.length < this.size) this.workers.push(new PoolWorker())
    return this.workers.reduce((best, worker) => (worker.streams < best.streams ? worker : best))
  }

  open(settings: OpusSettings): OpusStream {
    const worker = this.pick()
    const stream = this.nextStream++
    worker.streams += 1
    worker.post({ kind: 'open', stream, ...settings })
    let open = true
    const release = () => {
      if (!open) return
      open = false
      worker.streams -= 1
    }
    return {
      encode(pcm) {
        if (!open) return Promise.resolve(null)
        // A copy of its own, so the buffer can move to the worker without taking the socket's with it. Not
        // `slice()`: on a Buffer that is a view of the same memory, often a slab shared with other buffers.
        const own = new Uint8Array(pcm.length)
        own.set(pcm)
        return worker.ask((job) => ({ kind: 'encode', stream, job, pcm: own.buffer }), [own.buffer])
      },
      finish() {
        if (!open) return Promise.resolve(null)
        release()
        return worker.ask((job) => ({ kind: 'finish', stream, job }))
      },
      close() {
        if (!open) return
        release()
        worker.post({ kind: 'close', stream })
      },
    }
  }

  /** Stops the workers; a later speech starts new ones. */
  async close(): Promise<void> {
    const workers = this.workers
    this.workers = []
    await Promise.all(workers.map((worker) => worker.terminate()))
  }
}

let shared: OpusPool | null = null

/** The process's pool, made on first use. */
export function opusPool(): OpusPool {
  shared ??= new OpusPool()
  return shared
}
