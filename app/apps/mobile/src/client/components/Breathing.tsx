/**
 * Breathing circle, the product's visual anchor: four seconds in, four seconds out.
 * The animation is pure CSS, so it does not compete with the JS thread, and it honors the system
 * reduced-motion setting.
 *
 * Three layers: a wide glow (::before), a lit core that reads as a sphere rather than a flat ring,
 * and the crisp ring the person follows (::after).
 */
export default function Breathing({ size = 220, label }: { size?: number; label?: string }) {
  return (
    <div className="rd-breathing" style={{ width: size, height: size }} aria-hidden={!label}>
      <span className="rd-breathing-core" />
      {label && <span className="rd-breathing-label">{label}</span>}
    </div>
  )
}
