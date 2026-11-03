'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import BootSplash from '@/components/BootSplash'
import { useAuth } from '@/lib/auth'

/**
 * The address `/` leads home for everyone. Home itself knows who is there: someone signed in, a known
 * device that signs back in without a screen, or someone new, who meets home with the box to start
 * talking and the line about the agreement.
 */
export default function Index() {
  const { status } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (status !== 'restoring') router.replace('/home')
  }, [status, router])

  return <BootSplash />
}
