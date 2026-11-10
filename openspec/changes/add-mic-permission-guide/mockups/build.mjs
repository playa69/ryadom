// Генерирует макеты mockups/*.html (статичные, без зависимостей): node build.mjs
import { writeFileSync } from 'node:fs'
const states = {
  'denied-chrome-android': { title: 'Микрофон выключен', body: 'Браузер больше не спрашивает сам. Включи микрофон для Рядом:', steps: ['Нажми на значок замка слева от адреса', 'Выбери «Разрешения»', 'Включи «Микрофон»'], primary: 'Попробовать снова', secondary: 'Писать текстом' },
  'denied-safari-ios': { title: 'Микрофон выключен', body: 'Включи его для сайта в Safari:', steps: ['Нажми «Аа» в адресной строке', 'Выбери «Настройки веб-сайта»', 'Поставь «Микрофон» → «Разрешить»'], primary: 'Попробовать снова', secondary: 'Писать текстом' },
  'denied-embedded': { title: 'Здесь микрофон не включить', body: 'В окне другого приложения микрофон часто заблокирован. Открой Рядом в Chrome или Safari:', steps: ['Скопируй адрес — кнопка ниже', 'Открой Chrome или Safari и вставь его в адресную строку'], copy: 'Скопировать адрес', primary: 'Попробовать снова', secondary: 'Писать текстом' },
  'denied-pwa': { title: 'Микрофон выключен', body: 'Приложение Рядом не получило доступ к микрофону:', steps: ['Открой настройки телефона → «Приложения» → Рядом', 'Выбери «Разрешения» → «Микрофон»', 'Вернись и нажми «Попробовать снова»'], primary: 'Попробовать снова', secondary: 'Писать текстом' },
  'granted-after-denied': { title: 'Микрофон включён', body: 'Готово — можно говорить.', primary: 'Продолжить', secondary: 'Писать текстом' },
}
const css = `*{box-sizing:border-box}body{margin:0;height:100vh;font:16px/1.45 system-ui,sans-serif;color:#eef;background:#12131c;overflow:hidden}
.orb{position:absolute;left:50%;top:34%;width:160px;height:160px;margin:-80px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#b9a7ff,#5b4bd6 60%,#2a2370);opacity:.55}
.hint{position:absolute;top:34%;margin-top:110px;width:100%;text-align:center;color:#9a9cb5;font-size:14px}
.bar{position:absolute;bottom:0;width:100%;padding:16px;text-align:center;color:#6b6d85;font-size:13px}
.scrim{position:absolute;inset:0;background:rgba(5,5,12,.6);display:flex;align-items:flex-end;justify-content:center}
.sheet{width:100%;max-width:440px;background:#1c1d2b;border-radius:20px 20px 0 0;padding:24px 20px 28px;box-shadow:0 -8px 40px #0008}
@media(min-width:700px){.scrim{align-items:center}.sheet{border-radius:20px;padding:28px}}
h2{margin:0 0 8px;font-size:20px}p{margin:0 0 14px;color:#c4c6dc}
ol{margin:0 0 16px;padding:0;list-style:none;counter-reset:s}
li{counter-increment:s;display:flex;gap:12px;margin:0 0 10px;color:#eef}
li:before{content:counter(s);flex:none;width:26px;height:26px;border-radius:50%;background:#34355a;text-align:center;line-height:26px;font-size:14px}
button{font:inherit;width:100%;border:0;border-radius:14px;padding:13px;margin-top:8px}
.p{background:#7b68ee;color:#fff}.s{background:transparent;color:#b9bad6}.c{background:#2a2b40;color:#eef;margin:0 0 6px}`
for (const [name, s] of Object.entries(states)) {
  const steps = s.steps ? `<ol>${s.steps.map(t => `<li>${t}</li>`).join('')}</ol>` : ''
  const copy = s.copy ? `<button class="c">${s.copy}</button>` : ''
  writeFileSync(new URL(`${name}.html`, import.meta.url), `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${name}</title><style>${css}</style>
<div class=orb></div><div class=hint>Нажми и говори</div><div class=bar>Макет: ${name}</div>
<div class=scrim><div class=sheet><h2>${s.title}</h2><p>${s.body}</p>${steps}${copy}<button class=p>${s.primary}</button><button class=s>${s.secondary}</button></div></div>`)
}
