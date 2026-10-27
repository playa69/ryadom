import type { SelfCheckTest } from '../types'

// Satisfaction With Life Scale (Diener, Emmons, Larsen, Griffin, 1985). Diener's site: free to use without permission
// or fee with credit to the authors. Russian wording is our own translation.
export const swls: SelfCheckTest = {
  id: 'swls', version: 1, code: 'SWLS',
  title: 'Удовлетворённость жизнью', subtitle: 'SWLS', icon: 'sun',
  preface: 'Ниже пять утверждений. Насколько ты с ними согласен?',
  options: [
    { label: 'Совершенно не согласен', value: 1 },
    { label: 'Не согласен', value: 2 },
    { label: 'Скорее не согласен', value: 3 },
    { label: 'Ни то ни другое', value: 4 },
    { label: 'Скорее согласен', value: 5 },
    { label: 'Согласен', value: 6 },
    { label: 'Полностью согласен', value: 7 },
  ],
  items: [
    { text: 'В целом моя жизнь близка к идеалу' },
    { text: 'Условия моей жизни превосходны' },
    { text: 'Я доволен своей жизнью' },
    { text: 'Пока что я получил то важное, чего хотел от жизни' },
    { text: 'Если бы я мог прожить жизнь заново, я почти ничего не стал бы менять' },
  ],
  scoring: { kind: 'sum', max: 35 },
  bands: [
    { from: 0, to: 9, label: 'ориентир: очень далеко от удовлетворённости', tone: 'moderate', text: 'Сейчас жизнь мало похожа на ту, какой ты хочешь её видеть. Это повод подумать, что можно менять, и поговорить об этом.' },
    { from: 10, to: 14, label: 'ориентир: удовлетворённость низкая', tone: 'moderate', text: 'Ты не очень доволен жизнью. Помогает выбрать одну область и двигаться в ней небольшими шагами.' },
    { from: 15, to: 19, label: 'ориентир: чуть ниже середины', tone: 'mild', text: 'Есть и то, что устраивает, и то, что хотелось бы изменить.' },
    { from: 20, to: 20, label: 'ориентир: нейтрально', tone: 'mild', text: 'Доволен и недоволен примерно поровну.' },
    { from: 21, to: 25, label: 'ориентир: чуть выше середины', tone: 'calm', text: 'В целом ты доволен жизнью, но есть куда расти.' },
    { from: 26, to: 30, label: 'ориентир: высокая удовлетворённость', tone: 'calm', text: 'Ты доволен своей жизнью. Запомни, что тебе в этом помогает.' },
    { from: 31, to: 35, label: 'ориентир: очень высокая удовлетворённость', tone: 'calm', text: 'Ты очень доволен жизнью. Береги то, что её наполняет.' },
  ],
  source: 'Diener, Emmons, Larsen, Griffin, 1985; русская версия — наш перевод',
  license: 'Свободно, без разрешения и платы, с указанием авторов (сайт Э. Динера)',
}
