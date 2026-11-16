import { Icon } from 'framework7-react'
import type { ReactNode } from 'react'

/**
 * The collapsed «Настроить разговор» block of the home screen (PWA and Telegram), as on the web:
 * the optional memory choice folds in here, so the message field and the start button stay the
 * main actions. A native details/summary — collapsed by default and reachable by keyboard and
 * screen readers without extra state. The native shell keeps the choice in plain view.
 */
export default function ConversationSettings({ children }: { children: ReactNode }) {
  return (
    <details className="rd-conversation-settings" data-testid="home-settings">
      <summary>
        Настроить разговор
        <Icon f7="plus" size={14} aria-hidden="true" />
      </summary>
      <div className="rd-conversation-settings-body">{children}</div>
    </details>
  )
}
