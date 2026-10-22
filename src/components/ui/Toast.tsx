import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { CheckCircle2, XCircle, X } from 'lucide-react'
import { humanError } from '@/lib/errors'

interface ToastItem { id: number; kind: 'success' | 'error'; text: string }
interface ToastApi { success: (t: string) => void; error: (e: unknown) => void }

const Ctx = createContext<ToastApi | null>(null)
let seq = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const push = useCallback((kind: ToastItem['kind'], text: string) => {
    const id = ++seq
    setItems((x) => [...x, { id, kind, text }])
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === 'error' ? 8000 : 3500)
  }, [])
  const api: ToastApi = {
    success: (t) => push('success', t),
    error: (e) => push('error', typeof e === 'string' ? e : humanError(e)),
  }
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-3 z-[60] flex flex-col items-center gap-2 px-3 sm:bottom-auto sm:right-4 sm:top-4 sm:left-auto sm:items-end" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} className="pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm shadow-lg">
            {t.kind === 'success' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-rose-600" />}
            <span className="text-slate-800">{t.text}</span>
            <button onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))} className="text-slate-400 hover:text-slate-700" aria-label="Закрыть">
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export function useToast() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useToast вне ToastProvider')
  return ctx
}
