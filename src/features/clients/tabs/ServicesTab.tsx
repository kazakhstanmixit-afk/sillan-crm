import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'
import { Badge, Button, Card, ChipSelect, QueryState, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { useDicts } from '@/lib/dictionaries'
import { clientKeys } from '../api'

export function ServicesTab({ locationId, canEdit }: { locationId: string; canEdit: boolean }) {
  const d = useDicts()
  const keys = clientKeys(locationId)
  const qc = useQueryClient()
  const toast = useToast()
  const [editing, setEditing] = useState(false)

  const q = useQuery({
    queryKey: keys.services,
    queryFn: async () => {
      const [dirs, srv] = await Promise.all([
        supabase.from('location_directions').select('direction_id').eq('location_id', locationId),
        supabase.from('location_services').select('service_id').eq('location_id', locationId),
      ])
      return {
        directions: (unwrap(dirs) as { direction_id: string }[]).map((x) => x.direction_id),
        services: (unwrap(srv) as { service_id: string }[]).map((x) => x.service_id),
      }
    },
  })
  const [dirs, setDirs] = useState<string[]>([])
  const [srv, setSrv] = useState<string[]>([])
  useEffect(() => {
    if (q.data) { setDirs(q.data.directions); setSrv(q.data.services) }
  }, [q.data, editing])

  const save = useMutation({
    mutationFn: async () => unwrap(await supabase.rpc('set_location_links', { p_location: locationId, p_direction_ids: dirs, p_service_ids: srv })),
    onSuccess: () => {
      toast.success('Направления и услуги сохранены')
      qc.invalidateQueries({ queryKey: ['location', locationId] })
      qc.invalidateQueries({ queryKey: ['clients'] })
      setEditing(false)
    },
    onError: (e) => toast.error(e),
  })

  // услуги показываем сгруппированными по направлениям
  const groups = [
    ...d.directions.map((dir) => ({ id: dir.id, name: dir.name, items: d.services.filter((s) => s.direction_id === dir.id) })),
    { id: 'other', name: 'Прочие услуги', items: d.services.filter((s) => !s.direction_id) },
  ].filter((g) => g.items.length)

  return (
    <QueryState query={q}>
      <div className="space-y-4">
        <Card
          title="Направления деятельности"
          actions={canEdit && !editing && <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>Изменить</Button>}
        >
          {editing ? (
            <ChipSelect options={d.directions.filter((x) => x.is_active || dirs.includes(x.id)).map((x) => ({ value: x.id, label: x.name }))} value={dirs} onChange={setDirs} />
          ) : q.data?.directions.length ? (
            <div className="flex flex-wrap gap-1.5">{q.data.directions.map((id) => <Badge key={id} color="brand">{d.directionName(id)}</Badge>)}</div>
          ) : <p className="text-sm text-slate-500">Направления не указаны.</p>}
        </Card>

        <Card title="Предоставляемые услуги">
          {editing ? (
            <div className="space-y-3">
              {groups.map((g) => (
                <div key={g.id}>
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{g.name}</div>
                  <ChipSelect options={g.items.filter((s) => s.is_active || srv.includes(s.id)).map((s) => ({ value: s.id, label: s.name }))} value={srv} onChange={setSrv} />
                </div>
              ))}
            </div>
          ) : q.data?.services.length ? (
            <div className="flex flex-wrap gap-1.5">{q.data.services.map((id) => <Badge key={id}>{d.services.find((s) => s.id === id)?.name ?? '—'}</Badge>)}</div>
          ) : <p className="text-sm text-slate-500">Услуги не указаны.</p>}
        </Card>

        {editing && (
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEditing(false)} disabled={save.isPending}>Отмена</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Сохранить</Button>
          </div>
        )}
      </div>
    </QueryState>
  )
}
