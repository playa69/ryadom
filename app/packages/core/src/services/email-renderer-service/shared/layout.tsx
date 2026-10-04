import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components'
import type { ReactNode } from 'react'
import { colors, NBSP, styles } from './theme'

interface EmailLayoutProps {
  preview: string
  heading: string
  children: ReactNode
}

/** Shared email frame: the «Рядом» logo, a white card on paper, a short footer. */
export function EmailLayout({ preview, heading, children }: EmailLayoutProps) {
  return (
    <Html lang="ru">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.header}>
            <Text style={styles.logo}>
              Рядом<span style={{ color: colors.brand }}>.</span>
            </Text>
          </Section>
          <Section style={styles.card}>
            <Heading as="h1" style={styles.heading}>
              {heading}
            </Heading>
            {children}
          </Section>
          <Text style={styles.footer}>
            {`Письмо отправлено автоматически${NBSP}— отвечать на него не нужно.`}
            <br />
            {`«Рядом»${NBSP}— тёплый собеседник, когда нужно выговориться.`}
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

export function Paragraph({ children }: { children: ReactNode }) {
  return <Text style={styles.paragraph}>{children}</Text>
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>
}

export function CtaButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Section style={styles.buttonWrap}>
      <Button href={href} style={styles.button}>
        {children}
      </Button>
    </Section>
  )
}

/** The link as text, in case the button cannot be pressed (and for the plain-text version). */
export function FallbackLink({ href }: { href: string }) {
  return (
    <>
      <Hr style={styles.divider} />
      <Muted>
        Если кнопка не нажимается, скопируй ссылку в браузер:
        <br />
        <Link href={href} style={styles.link}>
          {href}
        </Link>
      </Muted>
    </>
  )
}

export function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} style={styles.link}>
      {children}
    </Link>
  )
}

/** The code large and spaced out between digits: it is typed by hand rather than followed as a link. */
export function CodeBlock({ code }: { code: string }) {
  return (
    <Section style={{ textAlign: 'center', margin: '24px 0' }}>
      <Text style={styles.code}>{code}</Text>
    </Section>
  )
}
