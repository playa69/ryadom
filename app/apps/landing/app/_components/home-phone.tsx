import { cn } from '@ryadom/ui/lib/utils'

/**
 * The app's home screen, a real screenshot (public/screens/home.webp): a 390px-wide phone at 2x. The
 * width and height reserve its shape before the file arrives, so the page does not jump when it loads.
 * It is the first picture on the page, so it loads at once. The screen carries its own top bar, so the
 * frame is only an edge. It shows the demo account, so refresh it from the same stack the e2e run uses.
 */
export function HeroPhone() {
  return (
    <div
      className={cn(
        'relative w-full max-w-65 justify-self-center overflow-hidden rounded-[36px] border border-line-strong bg-paper',
        '[box-shadow:var(--ryadom-highlight),var(--ryadom-shadow-2),0_0_100px_rgba(var(--ryadom-indigo-rgb),0.3)]',
        // A screenshot is 2.16 times taller than wide, so the widths are chosen by the height they give: the whole
        // phone has to sit in the first screen (606px high at 280, 649px at 300, 693px at 320). 360px is the floor:
        // below 400px the phone gives up its fixed width.
        'min-[400.02px]:w-[280px] min-[400.02px]:max-w-none min-[1280px]:w-[300px] min-[1600px]:w-[320px]',
      )}
    >
      {/* A plain <img>: the file is already sized and compressed, and the standalone server needs no image optimizer for it. */}
      <img
        src="/screens/home.webp"
        alt="Главный экран «Рядом»: приветствие, поле «Напиши или скажи, что на душе», режимы разговора и кнопка SOS"
        width={780}
        height={1688}
        fetchPriority="high"
        decoding="async"
        className="block h-auto w-full"
      />
    </div>
  )
}
