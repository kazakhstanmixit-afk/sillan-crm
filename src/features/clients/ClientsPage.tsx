import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Columns3, Download, Filter, Plus, UserCheck, PencilLine, X } from 'lucide-react'
import {
  Badge, Button, Card, Checkbox, EmptyState, ErrorState, Input, PageHeader, Pagination, Select, Spinner, useToast,
} from '@/components/ui'
import { usePerms } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { supabase } from '@/lib/supabase'
import { exportCsv, exportXlsx } from '@/lib/export'
import { todayISO } from '@/lib/format'
import {
  DEFAULT_FILTERS, PAGE_SIZE, fetchAllClients, fetchClientPage, fetchFilterOptions, filtersFromParams, filtersToParams, type ClientFilters,
} from './api'
import { CLIENT_COLUMNS, loadColumnPrefs, saveColumnPrefs, type ColumnPrefs } from './columns'
import { ColumnSettings } from './ColumnSettings'
import { BulkAssignDialog, BulkEditDialog } from './BulkDialogs'

export default function ClientsPage() {
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => filtersFromParams(params), [params])
  const d = useDicts()
  const perms = usePerms()
  const toast = useToast()

  const setFilters = useCallback(
    (patch: Partial<ClientFilters>, resetPage = true) => {
      const next = { ...filters, ...patch, ...(resetPage && !('page' in patch) ? { page: 1 } : {}) }
      setParams(filtersToParams(next), { replace: true })
    },
    [filters, setParams],
  )

  // поиск с задержкой, чтобы не дёргать базу на каждую букву
  const [q, setQ] = useState(filters.q)
  useEffect(() => setQ(filters.q), [filters.q])
  useEffect(() => {
    const t = setTimeout(() => q !== filters.q && setFilters({ q }), 350)
    return () => clearTimeout(t)
  }, [q, filters.q, setFilters])

  const list = useQuery({ queryKey: ['clients', 'list', filters], queryFn: () => fetchClientPage(filters), placeholderData: keepPreviousData })
  const options = useQuery({ queryKey: ['clients', 'options'], queryFn: fetchFilterOptions, staleTime: 5 * 60_000 })
  const company = useQuery({
    queryKey: ['company-name', filters.company],
    enabled: Boolean(filters.company),
    queryFn: async () => (await supabase.from('companies').select('name').eq('id', filters.company).maybeSingle()).data?.name as string | undefined,
  })

  const [prefs, setPrefs] = useState<ColumnPrefs>(loadColumnPrefs)
  const updatePrefs = (p: ColumnPrefs) => { setPrefs(p); saveColumnPrefs(p) }
  const columns = prefs.order.filter((k) => !prefs.hidden.includes(k)).map((k) => CLIENT_COLUMNS.find((c) => c.key === k)!)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [allMatching, setAllMatching] = useState(false)
  useEffect(() => { setSelected(new Set()); setAllMatching(false) }, [filters])
  const rows = list.data?.rows ?? []
  const total = list.data?.total ?? 0
  const pageAllSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const selectionCount = allMatching ? total : selected.size

  const getSelectedRows = useCallback(
    () => (allMatching ? fetchAllClients(filters) : Promise.resolve(rows.filter((r) => selected.has(r.id)))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allMatching, filters, selected, list.data],
  )

  const [showMore, setShowMore] = useState(Boolean(filters.lastFrom || filters.lastTo || filters.nextFrom || filters.nextTo))
  const [colsOpen, setColsOpen] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [exporting, setExporting] = useState<string | null>(null)

  const doExport = async (kind: 'csv' | 'xlsx') => {
    setExporting('Подготовка…')
    try {
      const all = await fetchAllClients(filters, 20000, (n) => setExporting(`Загружено ${n}…`))
      const cols = columns.map((c) => ({ header: c.label, value: (r: (typeof all)[number]) => c.exportValue(r, d) }))
      const name = `clients_${todayISO()}.${kind}`
      if (kind === 'csv') exportCsv(all, cols, name)
      else await exportXlsx(all, cols, name, 'Клиенты')
      toast.success(`Выгружено строк: ${all.length}`)
    } catch (e) {
      toast.error(e)
    } finally {
      setExporting(null)
    }
  }

  const activeFilters = (Object.keys(DEFAULT_FILTERS) as (keyof ClientFilters)[]).filter(
    (k) => !['sort', 'dir', 'page'].includes(k) && filters[k] !== DEFAULT_FILTERS[k],
  ).length

  const districts = (options.data?.districts ?? []).filter((x) => !filters.city || x.city === filters.city)
  const sortBy = (key?: string) => {
    if (!key) return
    setFilters({ sort: key, dir: filters.sort === key && filters.dir === 'asc' ? 'desc' : 'asc' })
  }

  return (
    <div>
      <PageHeader
        title="Клиенты"
        subtitle="Точки обслуживания: автосервисы, шиномонтажи, мойки и другие"
        actions={
          <>
            <Button icon={<Columns3 className="size-4" />} onClick={() => setColsOpen(true)}>Столбцы</Button>
            <Button icon={<Download className="size-4" />} loading={!!exporting} onClick={() => doExport('xlsx')} disabled={!total}>
              {exporting ?? 'Excel'}
            </Button>
            <Button onClick={() => doExport('csv')} disabled={!total || !!exporting}>CSV</Button>
            <Link to="/clients/new"><Button variant="primary" icon={<Plus className="size-4" />}>Добавить</Button></Link>
          </>
        }
      />

      <Card className="mb-3" bodyClassName="p-3 space-y-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-6">
          <Input className="lg:col-span-2" placeholder="Название, адрес, телефон, контакт…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск по клиентам" />
          <Select value={filters.city} onChange={(e) => setFilters({ city: e.target.value, district: '' })} aria-label="Город">
            <option value="">Все города</option>
            {options.data?.cities.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <Select value={filters.district} onChange={(e) => setFilters({ district: e.target.value })} aria-label="Район" disabled={!districts.length}>
            <option value="">Все районы</option>
            {districts.map((x) => <option key={x.city + x.district} value={x.district}>{filters.city ? x.district : `${x.district} (${x.city})`}</option>)}
          </Select>
          <Select value={filters.direction} onChange={(e) => setFilters({ direction: e.target.value })} aria-label="Направление">
            <option value="">Все направления</option>
            {d.activeDirections.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
          <Select value={filters.status} onChange={(e) => setFilters({ status: e.target.value })} aria-label="Статус">
            <option value="">Все статусы</option>
            {d.clientStatuses.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(perms.view_all || perms.view_team) && (
            <Select className="w-auto min-w-48" value={filters.manager} onChange={(e) => setFilters({ manager: e.target.value })} aria-label="Ответственный">
              <option value="">Все ответственные</option>
              <option value="none">Без ответственного</option>
              {d.managers.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
            </Select>
          )}
          <Button size="sm" variant="ghost" icon={<Filter className="size-3.5" />} onClick={() => setShowMore((s) => !s)}>
            Даты визитов
          </Button>
          {perms.archive && <Checkbox label="Архив" checked={filters.archived} onChange={(e) => setFilters({ archived: e.target.checked })} />}
          {filters.company && (
            <Badge color="brand" className="gap-1">
              Компания: {company.data ?? '…'}
              <button onClick={() => setFilters({ company: '' })} aria-label="Убрать фильтр по компании"><X className="size-3" /></button>
            </Badge>
          )}
          {activeFilters > 0 && (
            <Button size="sm" variant="ghost" onClick={() => { setQ(''); setParams(new URLSearchParams(), { replace: true }) }}>Сбросить фильтры ({activeFilters})</Button>
          )}
        </div>
        {showMore && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <label className="text-xs text-slate-500">Последний визит с<Input type="date" value={filters.lastFrom} onChange={(e) => setFilters({ lastFrom: e.target.value })} /></label>
            <label className="text-xs text-slate-500">Последний визит по<Input type="date" value={filters.lastTo} onChange={(e) => setFilters({ lastTo: e.target.value })} /></label>
            <label className="text-xs text-slate-500">Следующий визит с<Input type="date" value={filters.nextFrom} onChange={(e) => setFilters({ nextFrom: e.target.value })} /></label>
            <label className="text-xs text-slate-500">Следующий визит по<Input type="date" value={filters.nextTo} onChange={(e) => setFilters({ nextTo: e.target.value })} /></label>
          </div>
        )}
      </Card>

      {selectionCount > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm">
          <span>Выбрано: <b>{selectionCount}</b></span>
          {!allMatching && pageAllSelected && total > rows.length && (
            <button className="text-brand-700 underline" onClick={() => setAllMatching(true)}>Выбрать все {total} по фильтру</button>
          )}
          <span className="flex-1" />
          {perms.assign && <Button size="sm" variant="primary" icon={<UserCheck className="size-3.5" />} onClick={() => setAssignOpen(true)}>Назначить ответственного</Button>}
          {perms.edit_all && <Button size="sm" icon={<PencilLine className="size-3.5" />} onClick={() => setEditOpen(true)}>Изменить поля</Button>}
          <Button size="sm" variant="ghost" onClick={() => { setSelected(new Set()); setAllMatching(false) }}>Снять выбор</Button>
        </div>
      )}

      <Card bodyClassName="p-0">
        {list.isLoading ? <Spinner /> : list.error ? <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div> : rows.length === 0 ? (
          <EmptyState title={activeFilters ? 'По этим условиям клиентов нет' : 'В базе пока нет клиентов'}>
            {activeFilters
              ? 'Измените или сбросьте фильтры.'
              : perms.import ? 'Импортируйте выгрузку 2GIS в разделе «Импорт данных» или добавьте клиента вручную.' : 'Добавьте клиента вручную или попросите руководителя закрепить за вами точки.'}
          </EmptyState>
        ) : (
          <>
            <div className={`overflow-x-auto ${list.isFetching ? 'opacity-60' : ''}`}>
              <table className="data-table">
                <thead>
                  <tr>
                    {(perms.assign || perms.edit_all) && (
                      <th className="w-8">
                        <input
                          type="checkbox"
                          aria-label="Выбрать все на странице"
                          checked={pageAllSelected}
                          onChange={() => {
                            setAllMatching(false)
                            setSelected(pageAllSelected ? new Set() : new Set(rows.map((r) => r.id)))
                          }}
                        />
                      </th>
                    )}
                    {columns.map((c) => (
                      <th key={c.key}>
                        {c.sortKey ? (
                          <button className="inline-flex items-center gap-1 uppercase hover:text-slate-800" onClick={() => sortBy(c.sortKey)}>
                            {c.label}
                            {filters.sort === c.sortKey && (filters.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                          </button>
                        ) : c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      {(perms.assign || perms.edit_all) && (
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Выбрать ${r.name}`}
                            checked={allMatching || selected.has(r.id)}
                            onChange={() => {
                              setAllMatching(false)
                              const s = new Set(selected)
                              if (s.has(r.id)) s.delete(r.id)
                              else s.add(r.id)
                              setSelected(s)
                            }}
                          />
                        </td>
                      )}
                      {columns.map((c) => <td key={c.key}>{c.render(r, d)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={filters.page} pageSize={PAGE_SIZE} total={total} onPage={(p) => setFilters({ page: p }, false)} />
          </>
        )}
      </Card>

      <ColumnSettings open={colsOpen} onClose={() => setColsOpen(false)} prefs={prefs} onChange={updatePrefs} />
      <BulkAssignDialog open={assignOpen} onClose={() => setAssignOpen(false)} getRows={getSelectedRows} onDone={() => setSelected(new Set())} />
      <BulkEditDialog open={editOpen} onClose={() => setEditOpen(false)} getRows={getSelectedRows} />
    </div>
  )
}
