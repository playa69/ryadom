'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import BootSplash from '@/components/BootSplash'
import { useAuth, useClient } from '@/lib/auth'

/**
 * Where the address `/` sends the person. Someone signed in goes home. Someone who is not but has an
 * anonymous identity on this device is signed back in without a screen: that is an account with no
 * password to ask for. Anyone else is new here and meets the first screen; the sign-in screen is a
 * door they open themselves ("У меня уже есть аккаунт").
 */
export default function Index() {
  const { status, startAnonymously } = useAuth()
  const client = useClient()
  const router = useRouter()

  useEffect(() => {
    if (status === 'authenticated') {
      router.replace('/home')
      return
    }
    if (status !== 'anonymous') return

    let cancelled = false
    void (async () => {
      if (await client.hasDevice()) {
        try {
          // The agreements were given when the account was made; the app's gate asks again if a newer
          // version of the terms is out.
          await startAnonymously()
          return
        } catch {
          // The server does not answer or does not accept the key: the first screen is a fine place to land.
        }
      }
      if (!cancelled) router.replace('/welcome')
    })()
    return () => {
      cancelled = true
    }
  }, [status, client, startAnonymously, router])

  return <BootSplash />
}
