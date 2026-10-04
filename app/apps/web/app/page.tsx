'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import BootSplash from '@/components/BootSplash'
import { useAuth } from '@/lib/auth'

export default function Index() {
  const { status } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (status === 'authenticated') router.replace('/home')
    else if (status === 'anonymous') router.replace('/login')
  }, [status, router])

  return <BootSplash />
}
