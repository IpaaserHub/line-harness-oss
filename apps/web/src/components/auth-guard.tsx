'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'

/**
 * Origins allowed to inject credentials when this admin UI is embedded as an
 * iframe (TKDir / YTDir). Comma-separated, set at build time. When empty, the
 * postMessage bridge is disabled and only standalone login works.
 */
const ALLOWED_PARENT_ORIGINS = (process.env.NEXT_PUBLIC_ALLOWED_PARENT_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

function isEmbedded(): boolean {
  try {
    return window.self !== window.top
  } catch {
    // Cross-origin access to window.top throws — that itself means embedded.
    return true
  }
}

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    if (pathname === '/login') {
      setChecked(true)
      return
    }

    const key = localStorage.getItem('lh_api_key')
    if (key) {
      setChecked(true)
      return
    }

    // No stored key.
    //
    // When embedded in TKDir / YTDir, the parent frame injects per-account
    // credentials via postMessage instead of asking the user to log in.
    // Wait for that message rather than redirecting to /login.
    if (isEmbedded() && ALLOWED_PARENT_ORIGINS.length > 0) {
      const onMessage = (event: MessageEvent) => {
        if (!ALLOWED_PARENT_ORIGINS.includes(event.origin)) return
        const data = event.data as
          | { type?: string; apiUrl?: unknown; apiKey?: unknown }
          | null
        if (!data || data.type !== 'lh-auth' || typeof data.apiKey !== 'string') {
          return
        }
        if (typeof data.apiUrl === 'string' && data.apiUrl) {
          localStorage.setItem('lh_api_url', data.apiUrl)
        }
        localStorage.setItem('lh_api_key', data.apiKey)
        window.removeEventListener('message', onMessage)
        setChecked(true)
      }
      window.addEventListener('message', onMessage)
      // Signal the parent that this iframe is ready to receive credentials.
      // The ready ping carries no secret, so a wildcard target is acceptable.
      window.parent.postMessage({ type: 'lh-ready-for-auth' }, '*')
      return () => window.removeEventListener('message', onMessage)
    }

    // Standalone (not embedded): normal login redirect.
    router.replace('/login')
  }, [pathname, router])

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-[3px] border-gray-200 border-t-green-500 rounded-full" />
      </div>
    )
  }

  return <>{children}</>
}
