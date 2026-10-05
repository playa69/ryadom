import type { Metadata } from 'next'
import WelcomeScreen from './welcome-screen'

export const metadata: Metadata = { title: 'Добро пожаловать' }

export default function WelcomePage() {
  return <WelcomeScreen />
}
