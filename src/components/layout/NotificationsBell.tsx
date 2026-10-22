import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { fmtDateTime } from '@/lib/format'
import type { Notification } from '@/lib/types'
import { useToast } from '@/components/ui'

export function NotificationsBell() {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const nav = useNavigate()
  const toast = useToast()
  const box = useRef<HTMLDivElement>(null)

  const q = useQuery({
    queryKey: ['notifications'],
    refetchInterval: 60_000,
    queryFn: async () =>
      unwrap(await supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(30)) as Notification[],
  })
  const unread = (q.data ?? []).filter((n) => !n.is_read).length

  const markRead = useMutation({
    mutationFn: async (ids: string[] | null) => unwrap(await supabase.rpc('mark_notifications_read', { p_ids: ids })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
    onError: (e) => toast.error(e),
  })

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div ref={box} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="relative rounded-md p-2 text-slate-600 hover:bg-slate-100" aria-label={`Уведомления${unread ? `: ${unread} новых` : ''}`}>
        <Bell className="size-5" />
        {unread > 0 && (
          <span className="absolute right-1 top-1 min-w-4 rounded-full bg-rose-600 px-1 text-[10px] font-semibold leading-4 text-white">{unread > 9 ? '9+' : unread}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-[min(92vw,380px)] rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <span className="text-sm font-semibold">Уведомления</span>
            {unread > 0 && (
              <button className="text-xs text-brand-600 hover:underline" onClick={() => markRead.mutate(null)} disabled={markRead.isPending}>
                Отметить все прочитанными
              </button>
            )}
          </div>
          <ul className="max-h-[60vh] overflow-y-auto">
            {q.isLoading && <li className="px-3 py-4 text-sm text-slate-500">Загрузка…</li>}
            {q.data?.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-500">Новых уведомлений нет</li>}
            {q.data?.map((n) => (
              <li key={n.id}>
                <button
                  className={`block w-full border-b border-slate-50 px-3 py-2 text-left hover:bg-slate-50 ${n.is_read ? '' : 'bg-brand-50/60'}`}
                  onClick={() => {
                    if (!n.is_read) markRead.mutate([n.id])
                    setOpen(false)
                    if (n.link) nav(n.link)
                  }}
                >
                  <div className="text-sm text-slate-900">{n.title}</div>
                  {n.body && <div className="truncate text-xs text-slate-500">{n.body}</div>}
                  <div className="mt-0.5 text-[11px] text-slate-400">{fmtDateTime(n.created_at)}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
