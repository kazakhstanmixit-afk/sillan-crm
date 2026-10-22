import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import type { Permissions, Profile } from '@/lib/types'

interface AuthState {
  session: Session | null
  loading: boolean
  profile: Profile | null
  perms: Permissions | null
  permsLoading: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const qc = useQueryClient()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      if (!s) qc.clear()
    })
    return () => data.subscription.unsubscribe()
  }, [qc])

  const userId = session?.user.id
  const me = useQuery({
    queryKey: ['me', userId],
    enabled: Boolean(userId),
    queryFn: async () => {
      const [profile, perms] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', userId!).maybeSingle(),
        supabase.rpc('my_permissions'),
      ])
      return { profile: unwrap(profile) as Profile | null, perms: unwrap(perms) as Permissions }
    },
  })

  const value = useMemo<AuthState>(
    () => ({
      session,
      loading,
      profile: me.data?.profile ?? null,
      perms: me.data?.perms ?? null,
      permsLoading: me.isLoading,
      signOut: async () => {
        await supabase.auth.signOut()
        qc.clear()
      },
    }),
    [session, loading, me.data, me.isLoading, qc],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth вне AuthProvider')
  return ctx
}

/** Права текущего пользователя (для показа/скрытия действий; проверка — в базе). */
export function usePerms(): Permissions {
  const { perms } = useAuth()
  return (
    perms ?? {
      role: null, active: false, view_all: false, edit_all: false, assign: false, view_team: false,
      archive: false, import: false, manage_users: false, manage_dictionaries: false,
    }
  )
}
