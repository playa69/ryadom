import { BrandMark } from './Brand'

/** Shown while the stored session is being restored; decorative, so hidden from assistive tech. */
export default function BootSplash() {
  return (
    <div className="fixed inset-0 flex items-center justify-center" aria-hidden="true">
      <BrandMark size={72} />
    </div>
  )
}
