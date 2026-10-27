import type { SelfCheckTest } from '../types'

// Satisfaction With Life Scale (Diener, Emmons, Larsen, Griffin, 1985). Diener's site: copyrighted, but free to use
// without permission or charge by professionals as long as the four authors are credited (shown on the result screen);
// translating is allowed. Russian wording is our own, kept free of gendered forms. Commercial use is not addressed there.
export const swls: SelfCheckTest = {
  id: 'swls', version: 1, code: 'SWLS',
  title: 'Удовлетворённость жизнью', subtitle: 'SWLS', icon: 'sun',
  preface: 'Ниже пять утверждений. Насколько каждое из них верно для тебя?',
  options: [
    { label: 'Совершенно неверно', value: 1 },
    { label: 'Неверно', value: 2 },
    { label: 'Скорее неверно', value: 3 },
    { label: 'Ни то ни другое', value: 4 },
    { label: 'Скорее верно', value: 5 },
    { label: 'Верно', value: 6 },
    { label: 'Совершенно верно', value: 7 },
  ],
  items: [
    { text: 'В целом моя жизнь близка к идеалу' },
    { text: 'Условия моей жизни превосходны' },
    { text: 'Жизнь меня вполне устраивает' },
    { text: 'Пока что в моей жизни появилось то важное, чего мне хотелось' },
    { text: 'Если бы можно было прожить жизнь заново, почти ничего не хотелось бы менять' },
  ],
  scoring: { kind: 'sum', max: 35 },
  bands: [
    { from: 0, to: 9, label: 'ориентир: очень далеко от удовлетворённости', tone: 'moderate', text: 'Сейчас жизнь мало похожа на ту, какой ты хочешь её видеть. Это повод подумать, что можно менять, и поговорить об этом.' },
    { from: 10, to: 14, label: 'ориентир: удовлетворённость низкая', tone: 'moderate', text: 'Жизнь устраивает тебя не очень. Помогает выбрать одну область и двигаться в ней небольшими шагами.' },
    { from: 15, to: 19, label: 'ориентир: чуть ниже середины', tone: 'mild', text: 'Есть и то, что устраивает, и то, что хотелось бы изменить.' },
    { from: 20, to: 20, label: 'ориентир: нейтрально', tone: 'mild', text: 'Устраивает и не устраивает примерно поровну.' },
    { from: 21, to: 25, label: 'ориентир: чуть выше середины', tone: 'calm', text: 'В целом жизнь тебя устраивает, но есть куда расти.' },
    { from: 26, to: 30, label: 'ориентир: высокая удовлетворённость', tone: 'calm', text: 'Жизнь тебя устраивает. Запомни, что в этом помогает.' },
    { from: 31, to: 35, label: 'ориентир: очень высокая удовлетворённость', tone: 'calm', text: 'Жизнь тебя очень устраивает. Береги то, что её наполняет.' },
  ],
  source: 'Ed Diener, Robert A. Emmons, Randy J. Larsen, Sharon Griffin, 1985 (Journal of Personality Assessment, 49, 71–75); русская версия — наш перевод',
  license: 'Авторские права сохраняются; свободно, без разрешения и платы, с указанием четырёх авторов; перевод разрешён (сайт Э. Динера)',
}
