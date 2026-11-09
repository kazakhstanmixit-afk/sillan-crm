import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { callBitrix } from '@/lib/bitrix'
import { usePerms } from '@/auth/AuthProvider'

/** Строка «Битрикс24» в карточке заявки: в какую сделку ушла, ждёт или ошибка */
export function BitrixStatus({ requestId, dealRef, syncedAt }: { requestId: string; dealRef: string | null | undefined; syncedAt: string | null | undefined }) {
  const qc = useQueryClient()
  const toast = useToast()
  const perms = usePerms()
  const q = useQuery({
    queryKey: ['bitrix_deal', dealRef],
    enabled: !!dealRef,
    queryFn: async () => {
      const [deal, cfg] = await Promise.all([
        supabase.from('bitrix_deals').select('status, bitrix_deal_id, error').eq('id', dealRef!).maybeSingle(),
        supabase.from('app_settings').select('value').eq('key', 'bitrix_deals').maybeSingle(),
      ])
      return {
        deal: unwrap(deal) as { status: string; bitrix_deal_id: string | null; error: string | null } | null,
        cfg: ((unwrap(cfg) as { value: { enabled?: boolean; portal_url?: string } } | null)?.value ?? {}),
      }
    },
  })
  const send = useMutation({
    mutationFn: () => callBitrix({ action: 'sync', request_ids: [requestId] }),
    onSuccess: (r) => {
      if (r.error) toast.error(new Error(r.error))
      else if (r.errors?.length) toast.error(new Error(r.errors[0]))
      else if (r.disabled) toast.error(new Error('Отправка в Битрикс24 выключена в настройках'))
      else toast.success('Отправлено в Битрикс24')
      qc.invalidateQueries({ queryKey: ['bitrix_deal', dealRef] })
      qc.invalidateQueries({ queryKey: ['request', requestId] })
    },
  })
  if (!dealRef || !q.data?.deal || !q.data.cfg.enabled) return null
  const { deal, cfg } = q.data
  const link = deal.bitrix_deal_id && cfg.portal_url ? `${cfg.portal_url.replace(/\/$/, '')}/crm/deal/details/${deal.bitrix_deal_id}/` : null
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {syncedAt && deal.bitrix_deal_id
        ? (link ? <a href={link} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">Сделка №{deal.bitrix_deal_id}</a> : <span>Сделка №{deal.bitrix_deal_id}</span>)
        : deal.status === 'error'
          ? <span className="text-red-700">Не отправлено: {deal.error}</span>
          : <span className="text-slate-500">Ожидает отправки</span>}
      {(perms.view_team || !syncedAt) && (deal.status !== 'sent' || !syncedAt) && (
        <Button size="sm" loading={send.isPending} onClick={() => send.mutate()}>Отправить</Button>
      )}
    </div>
  )
}
