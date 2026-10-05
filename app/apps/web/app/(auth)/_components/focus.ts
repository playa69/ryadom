/*
 * The keyboard focus ring of the product: a gap in the page color, then a light-blue ring, so the halo
 * reads on any background. It replaces the shared components' softer 3px ring on these screens.
 */
export const FOCUS_RING =
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-paper'

/*
 * A text field: only the lit top edge, no drop shadow, and the ring replaces that edge once the
 * field has focus. A field in error keeps its red border, with the ring added while it has focus.
 * No vertical padding: the text is centered in the fixed height, and padding would shrink the
 * selection highlight of a large code.
 *
 * Chrome paints an autofilled field light. The global rule that puts the dark fill back sits in the
 * base layer, which every shadow utility above beats, so the fill is repeated here as a shadow; the
 * stacked focus variant also outranks `focus-visible:shadow-none`, and the ring composes on top.
 */
export const FIELD_FOCUS = `${FOCUS_RING} py-0 shadow-[var(--ryadom-highlight)] focus-visible:shadow-none aria-invalid:ring-0 aria-invalid:focus-visible:border-destructive aria-invalid:focus-visible:ring-2 aria-invalid:focus-visible:ring-ring autofill:shadow-[inset_0_0_0_1000px_var(--ryadom-paper)] autofill:focus-visible:shadow-[inset_0_0_0_1000px_var(--ryadom-paper)]`
