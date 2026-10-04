# @ryadom/ui

Общий набор компонентов **shadcn/ui** (радикс-основа, стиль `radix-nova`) на **Tailwind CSS v4** для
`apps/web` и `apps/landing`. Мобильный клиент (Framework7) и админка (`apps/admin`, свой CSS) сюда не
входят; цвета, радиусы и тени у всех одни — из `@ryadom/design`.

## Что внутри

- `src/components/*.tsx` — компоненты shadcn (скопированы CLI, дальше — наш код: правь свободно) и наши:
  `orb.tsx` (дышащая сфера), `password-input.tsx` (поле пароля с глазом), `native-checkbox.tsx` (флажок-`input`
  без inline-стиля на сервере: у Radix Checkbox он есть, а CSP веба его запрещает).
- `src/lib/utils.ts` — `cn()` (clsx + tailwind-merge).
- `src/styles/globals.css` — единственный CSS пакета: подключает Tailwind, `tw-animate-css` и токены
  `@ryadom/design`, связывает переменные shadcn (`--primary`, `--border`…) с токенами «Рядом»,
  объявляет цвета/радиусы/брейкпоинты/анимации в `@theme` и несколько `@utility`.

## Как подключено приложение

```
apps/<app>/postcss.config.mjs   export { default } from '@ryadom/ui/postcss.config'
apps/<app>/app/globals.css      @import "@ryadom/ui/globals.css"; @source "<свои папки>";
apps/<app>/app/layout.tsx       import './globals.css'; <html className="dark">
apps/<app>/next.config.ts       transpilePackages: ['@ryadom/ui', …]
apps/<app>/components.json      для `shadcn add` из каталога приложения
```

Продукт только тёмный: на `<html>` всегда класс `dark`, переменные заданы сразу тёмными значениями.

## Тема

| Что | Как называется в классах |
|---|---|
| фон, текст, граница, фокус | `bg-background text-foreground border-border ring-ring` (shadcn) |
| главное действие (синий #007AFF, как в референсе) | `bg-primary text-primary-foreground` (заливка `#0070f0`, белый текст ≥ 4,5:1), градиент со свечением — утилита `cta` |
| приглушённый / вторичный текст | `text-muted-foreground` (= `text-dim`), `text-faint` |
| стекло | утилиты `glass`, `glass-2` (фон + блюр + светлая кромка), цвета `bg-glass`, `bg-glass-2`, `bg-bars` |
| граница контрола (3:1) | `border-input` (= `border-line-strong`); декоративная линия — `border-line` |
| синий / мята / опасность / SOS | `text-brand-400` (текст и иконки на тёмном), `bg-brand` (точки, кольца), `bg-brand-soft`, `border-brand-line`; `…-sage…`; `…-danger…`; `text-sos`; тёплый «персик» только в сфере (`--ryadom-peach`) |
| радиусы | `rounded-lg` 20px, `rounded-xl` 28px, `rounded-2xl` 36px, `rounded-full` для кнопок и пилюль |
| тени | `shadow-card`, `shadow-float`, `shadow-cta` |
| брейкпоинты | `tab:` от 700px (планшет: шапки и поля просторнее), `desk:` от 1024px (широкий экран); сайдбар веба переключается на `md` (768px) |
| анимации | `animate-breathe`, `animate-orb`, `animate-blink`, `animate-rec` (все гасятся `motion-reduce:`) |
| небо (звёзды + свечение) | `sky` — уже на `body`; для отдельной поверхности `bg-paper` |

Значения живут в `packages/design/tokens.css` — меняй их там, не здесь.

## Правила

1. **Никакого рукописного CSS в приложениях.** Стили — утилитами в `className`. Свой CSS допустим только
   как `@utility` / `@theme` в `globals.css` этого пакета, и только для повторяющегося узора (стекло,
   сфера), а не ради одного места.
2. **Условные классы — через `cn()`**, варианты — через `cva` (как в shadcn).
3. **Новый компонент shadcn:** `pnpm dlx shadcn@latest add <имя> -c packages/ui`, затем подгони под тему
   (кнопки-пилюли, поля 52px, стекло) и положи правки в тот же файл.
4. **Политика безопасности (CSP) веба запрещает `style=""` в серверной разметке.** Не используй проп
   `style` и компоненты, которые его рендерят на сервере (`InputOTP`, `Toaster` с `style`). Размеры и цвета —
   классами, значения — через arbitrary values (`w-[min(92vw,520px)]`) или CSS-переменные в классе.
5. **Иконки — `lucide-react`.** Свои SVG только для знака бренда.
6. **Доступность не теряем:** цели ≥ 44px (`h-11` и выше), вторичный текст не темнее `text-faint`, фокус
   виден, `aria-*`, `data-testid` и роли сохраняются — на них держатся e2e.
7. **Контент не меняем:** тексты интерфейса русские, на «ты».
8. Комментарии в коде — английские, короткие, только «почему».

## Проверка глазами

```
node e2e/scripts/ui-shots.mjs --app web --base http://localhost:3023 --login      # один раз
node e2e/scripts/ui-shots.mjs --app web --base http://localhost:3023 --screens home --out screenshots/tw/web
node e2e/scripts/ui-diff.mjs --a screenshots/baseline/web --b screenshots/tw/web --only web-home
```

`ui-shots` снимает те же экраны и размеры, что наборы в `screenshots/`, и печатает горизонтальное
переполнение; `ui-diff` показывает долю изменённых пикселей и кладёт картинку-разницу рядом.
