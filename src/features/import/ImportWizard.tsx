import { useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Upload } from 'lucide-react'
import { Badge, Button, Card, Checkbox, ChipSelect, ErrorState, Field, Input, Select, Spinner, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { humanError, unwrap } from '@/lib/errors'
import { useDicts } from '@/lib/dictionaries'
import { formatPhone } from '@/lib/phone'
import { parseFile, type ParsedFile, type ParsedSheet } from '@/lib/import/parse'
import { CRM_FIELDS, TEMPLATE_HEADERS, buildRow, suggestMapping, type CrmField, type MappingSuggestion } from '@/lib/import/mapping'
import { exportCsv } from '@/lib/export'
import { defaultAction, markInFileDuplicates, summarize, type ImportMode, type PlannedRow, type PreviewItem } from '@/lib/import/classify'
import { downloadJobReport } from './report'

type Step = 'upload' | 'map' | 'review' | 'running' | 'done'

const UPDATE_FIELDS: { key: string; label: string }[] = [
  { key: 'name', label: 'Название' }, { key: 'city', label: 'Город' }, { key: 'district', label: 'Район' },
  { key: 'address', label: 'Адрес из источника' }, { key: 'phones', label: 'Телефоны (добавить новые)' }, { key: 'website', label: 'Сайт' },
  { key: 'coords', label: 'Координаты' }, { key: 'category', label: 'Категория' }, { key: 'source_url', label: 'Ссылка на источник' },
  { key: 'directions', label: 'Направления (добавить)' },
]
const MODES: { value: ImportMode; label: string; hint: string }[] = [
  { value: 'add_new', label: 'Только добавить новые', hint: 'Существующие записи не меняются' },
  { value: 'update_allowed', label: 'Обновить разрешённые поля', hint: 'Существующие записи дополняются выбранными полями; пустые значения ничего не стирают' },
  { value: 'skip_existing', label: 'Пропустить существующие', hint: 'Как «только новые», но совпадения явно помечаются пропущенными' },
]
const BATCH = 200
const PREVIEW_CHUNK = 500

const ACTION_LABEL: Record<string, string> = { create: 'Создать', update: 'Обновить', merge: 'Объединить', skip: 'Пропустить', conflict: 'Нужно решение', error: 'Ошибка' }
const ACTION_COLOR: Record<string, string> = { create: 'green', update: 'blue', merge: 'violet', skip: 'gray', conflict: 'amber', error: 'rose' }

export function ImportWizard() {
  const d = useDicts()
  const toast = useToast()
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>('upload')
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [sheet, setSheet] = useState('')
  const [data, setData] = useState<ParsedSheet | null>(null)
  const [mapping, setMapping] = useState<Record<string, CrmField | ''>>({})
  const [showAllCols, setShowAllCols] = useState(false)
  const [hints, setHints] = useState<Pick<MappingSuggestion, 'auto' | 'suggestions'>>({ auto: [], suggestions: {} })
  const applyAutoMapping = (headers: string[]) => {
    const r = suggestMapping(headers)
    setMapping(r.mapping)
    setHints({ auto: r.auto, suggestions: r.suggestions })
  }
  // направления Sillan: по ключевым словам из категории 2GIS и/или вручную для всех записей файла
  const [useKeywords, setUseKeywords] = useState(true)
  const [extraDirs, setExtraDirs] = useState<string[]>([])
  const finalDirections = (r: PlannedRow) => [...new Set([...(useKeywords ? r.built.data.direction_ids : []), ...extraDirs])]
  const [source, setSource] = useState('2gis')
  const [mode, setMode] = useState<ImportMode>('add_new')
  const [updateFields, setUpdateFields] = useState<string[]>(['address', 'phones', 'website', 'coords', 'category', 'source_url'])
  const [rows, setRows] = useState<PlannedRow[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [filter, setFilter] = useState<string>('conflict')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [result, setResult] = useState<{ id: string; status: string; created_count: number; updated_count: number; skipped_count: number; conflict_count: number; error_count: number } | null>(null)

  const reset = () => {
    setStep('upload'); setFileName(''); setParsed(null); setSheet(''); setData(null); setMapping({}); setHints({ auto: [], suggestions: {} }); setRows([]); setError(null); setResult(null); setExtraDirs([]); setUseKeywords(true)
  }

  const onFile = async (f: File) => {
    setError(null)
    setBusy('Чтение файла…')
    try {
      if (f.size > 30 * 1024 * 1024) throw new Error('Файл больше 30 МБ — разделите его на части')
      const p = await parseFile(f)
      setFileName(f.name)
      setParsed(p)
      const first = p.sheets[0] ?? ''
      setSheet(first)
      const s = await p.read(first || undefined)
      if (!s.rows.length) throw new Error('В файле не найдено строк с данными (первая строка — заголовки)')
      setData(s)
      applyAutoMapping(s.headers)
      setStep('map')
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  const changeSheet = async (name: string) => {
    if (!parsed) return
    setSheet(name)
    setBusy('Чтение листа…')
    try {
      const s = await parsed.read(name)
      setData(s)
      applyAutoMapping(s.headers)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  const nameMapped = Object.values(mapping).includes('name')
  const keyMapped = Object.values(mapping).includes('external_id') || Object.values(mapping).includes('address')

  // Проверка: локальная валидация + поиск совпадений в базе порциями
  const analyze = async () => {
    if (!data) return
    setError(null)
    setBusy('Проверка строк…')
    try {
      const planned: PlannedRow[] = data.rows.map((raw, i) => ({ row: data.rowNumbers[i], raw, built: buildRow(raw, mapping, d.directions), action: 'create' }))
      markInFileDuplicates(planned)
      const toCheck = planned.filter((r) => !r.built.errors.length && r.inFileDuplicateOf === undefined)
      for (let i = 0; i < toCheck.length; i += PREVIEW_CHUNK) {
        setBusy(`Поиск совпадений в базе: ${Math.min(i + PREVIEW_CHUNK, toCheck.length)} из ${toCheck.length}…`)
        const part = toCheck.slice(i, i + PREVIEW_CHUNK)
        const res = unwrap(await supabase.rpc('import_preview', {
          p_source: source.trim() || 'import',
          p_rows: part.map((r) => ({ row: r.row, name: r.built.data.name, city: r.built.data.city, address: r.built.data.address, external_id: r.built.data.external_id || null, phones: r.built.data.phones })),
        })) as PreviewItem[]
        const byRow = new Map(res.map((x) => [x.row, x]))
        for (const r of part) r.preview = byRow.get(r.row)
      }
      for (const r of planned) Object.assign(r, defaultAction(r, mode))
      setRows(planned)
      setFilter(planned.some((r) => r.action === 'conflict') ? 'conflict' : 'all')
      setStep('review')
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  const changeMode = (m: ImportMode) => {
    setMode(m)
    setRows((rs) => rs.map((r) => {
      // ручные решения по конфликтам сохраняем, остальное пересчитываем
      const manual = r.preview && !r.preview.match && r.preview.possible.length && r.action !== 'conflict'
      return manual ? r : { ...r, ...defaultAction(r, m) }
    }))
  }
  const decide = (row: number, patch: Partial<PlannedRow>) => setRows((rs) => rs.map((r) => (r.row === row ? { ...r, ...patch } : r)))
  const decideAllConflicts = (action: 'create' | 'skip') =>
    setRows((rs) => rs.map((r) => (r.action === 'conflict' ? { ...r, action, message: action === 'create' ? 'Создано отдельно (решение пользователя)' : 'Пропущено (решение пользователя)' } : r)))

  const sum = useMemo(() => summarize(rows), [rows])

  const run = async () => {
    setError(null)
    setStep('running')
    setProgress({ done: 0, total: rows.length })
    let jobId: string | null = null
    try {
      const job = unwrap(await supabase.from('import_jobs').insert({
        file_name: fileName, sheet_name: sheet || null, source: source.trim() || 'import', mode,
        update_fields: mode === 'update_allowed' ? updateFields : [], mapping, total_rows: rows.length,
      }).select('id').single()) as { id: string }
      jobId = job.id
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH).map((r) => ({
          row: r.row, action: r.action, location_id: r.location_id ?? null, message: r.message ?? null,
          raw: Object.fromEntries(Object.entries(r.raw).filter(([h, v]) => mapping[h] && v !== '')),
          data: { ...r.built.data, external_id: r.built.data.external_id || null, direction_ids: finalDirections(r) },
        }))
        // повторная отправка безопасна: база пропускает уже обработанные строки
        let attempt = 0
        for (;;) {
          try {
            unwrap(await supabase.rpc('import_apply_batch', { p_job: jobId, p_rows: batch }))
            break
          } catch (e) {
            if (++attempt >= 3) throw e
            await new Promise((r) => setTimeout(r, 1500 * attempt))
          }
        }
        setProgress({ done: Math.min(i + BATCH, rows.length), total: rows.length })
      }
      const fin = unwrap(await supabase.rpc('import_finish', { p_job: jobId, p_failed: false })) as typeof result
      setResult(fin)
      setStep('done')
      toast.success('Импорт завершён')
    } catch (e) {
      setError(e)
      if (jobId) {
        const fin = (await supabase.rpc('import_finish', { p_job: jobId, p_failed: true })).data as typeof result
        setResult(fin)
      }
      setStep('done')
    } finally {
      qc.invalidateQueries({ queryKey: ['clients'] })
      qc.invalidateQueries({ queryKey: ['import-jobs'] })
    }
  }

  const downloadTemplate = () =>
    exportCsv([] as Record<string, string>[], TEMPLATE_HEADERS.map((h) => ({ header: h, value: (r: Record<string, string>) => r[h] })), 'sillan_crm_import_template.csv')

  if (busy) return <Card><Spinner label={busy} /></Card>

  if (step === 'upload') {
    return (
      <Card>
        <div
          className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-slate-300 px-4 py-12 text-center"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
        >
          <FileSpreadsheet className="size-10 text-slate-300" />
          <div>
            <p className="font-medium text-slate-800">Перетащите файл CSV или XLSX сюда</p>
            <p className="text-sm text-slate-500">Первая строка — заголовки столбцов. Подходят выгрузки 2GIS и любые таблицы.</p>
          </div>
          <input ref={input} type="file" accept=".csv,.xlsx,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f) }} />
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => input.current?.click()}>Выбрать файл</Button>
            <Button icon={<Download className="size-4" />} onClick={downloadTemplate}>Скачать шаблон CSV</Button>
          </div>
          <p className="max-w-lg text-xs text-slate-500">Шаблон не обязателен: выгрузку Apify (2GIS) можно загружать как есть — столбцы title, phoneValue, url, location/lat и другие сопоставятся автоматически.</p>
        </div>
        {error ? <div className="mt-3"><ErrorState error={error} /></div> : null}
        <p className="mt-3 text-xs text-slate-500">Автоматический сбор данных с 2GIS не выполняется: загружайте подготовленные выгрузки, полученные допустимым способом.</p>
      </Card>
    )
  }

  if (step === 'map' && data) {
    const preview = data.rows.slice(0, 8)
    const many = data.headers.length > 30
    // при сотнях служебных столбцов (часы работы, отзывы, атрибуты) показываем только значимые
    const cols = many && !showAllCols ? data.headers.filter((h) => mapping[h] || hints.suggestions[h]) : data.headers
    return (
      <div className="space-y-4">
        <Card title={`Файл: ${fileName}`} actions={<Button size="sm" variant="ghost" onClick={reset}>Другой файл</Button>}>
          <div className="grid gap-3 sm:grid-cols-3">
            {parsed?.sheets && parsed.sheets.length > 1 && (
              <Field label="Лист">{(id) => <Select id={id} value={sheet} onChange={(e) => changeSheet(e.target.value)}>{parsed.sheets.map((s) => <option key={s}>{s}</option>)}</Select>}</Field>
            )}
            <Field label="Источник данных" hint="По нему сопоставляются внешние ID при повторном импорте">{(id) => <Input id={id} value={source} onChange={(e) => setSource(e.target.value)} maxLength={50} />}</Field>
            <div className="text-sm text-slate-600 sm:self-end">Строк с данными: <b>{data.rows.length}</b></div>
          </div>
        </Card>

        <Card
          title="Сопоставление столбцов"
          actions={many && <Checkbox label={`Показать все столбцы (${data.headers.length})`} checked={showAllCols} onChange={(e) => setShowAllCols(e.target.checked)} />}
          bodyClassName="p-0"
        >
          {many && !showAllCols && (
            <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
              Показаны столбцы, которые загружаются или похожи на нужные: {cols.length} из {data.headers.length}. Остальные (часы работы, отзывы, атрибуты и т.п.) не загружаются.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>{cols.map((h) => (
                  <th key={h} className="min-w-44 normal-case">
                    <div className="mb-1 truncate text-slate-700" title={h}>{h}</div>
                    <Select className="h-8 text-xs font-normal normal-case" value={mapping[h] ?? ''} onChange={(e) => { setMapping({ ...mapping, [h]: e.target.value as CrmField | '' }); setHints((x) => ({ auto: x.auto.filter((a) => a !== h), suggestions: Object.fromEntries(Object.entries(x.suggestions).filter(([k]) => k !== h)) })) }} aria-label={`Поле для столбца ${h}`}>
                      <option value="">— не загружать —</option>
                      {CRM_FIELDS.map((f) => (
                        <option key={f.key} value={f.key} disabled={!f.multi && mapping[h] !== f.key && Object.values(mapping).includes(f.key)}>{f.label}</option>
                      ))}
                    </Select>
                    {hints.auto.includes(h) && mapping[h] && <div className="mt-1"><Badge color="green">авто</Badge></div>}
                    {hints.suggestions[h] && !mapping[h] && (
                      <div className="mt-1 whitespace-normal text-[11px] font-normal normal-case text-amber-700">
                        {hints.suggestions[h].reason}
                        {!(!CRM_FIELDS.find((f) => f.key === hints.suggestions[h].field)?.multi && Object.values(mapping).includes(hints.suggestions[h].field)) && (
                          <button type="button" className="ml-1 font-medium underline" onClick={() => { const f = hints.suggestions[h].field; setMapping({ ...mapping, [h]: f }) }}>Принять</button>
                        )}
                      </div>
                    )}
                  </th>
                ))}</tr>
              </thead>
              <tbody>
                {preview.map((r, i) => <tr key={i}>{cols.map((h) => <td key={h} className="max-w-56 truncate text-xs">{r[h]}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
        </Card>

        {Object.keys(hints.suggestions).some((h) => !mapping[h]) && (
          <p className="flex items-center gap-2 text-sm text-amber-700"><AlertTriangle className="size-4" />Есть неоднозначные столбцы — они не загружаются, пока вы не выберете поле вручную или не нажмёте «Принять».</p>
        )}
        {!nameMapped && <p className="flex items-center gap-2 text-sm text-rose-600"><AlertTriangle className="size-4" />Выберите столбец для поля «Название».</p>}
        {nameMapped && !keyMapped && <p className="flex items-center gap-2 text-sm text-amber-700"><AlertTriangle className="size-4" />Нет ни внешнего ID, ни адреса — повторный импорт сможет находить совпадения только по телефону и названию.</p>}
        {error ? <ErrorState error={error} /> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={reset}>Отмена</Button>
          <Button variant="primary" disabled={!nameMapped} onClick={analyze}>Проверить данные</Button>
        </div>
      </div>
    )
  }

  if (step === 'review') {
    const shown = rows.filter((r) => filter === 'all' || r.action === filter).slice(0, 300)
    return (
      <div className="space-y-4">
        <Card title="Режим импорта">
          <div className="grid gap-2 sm:grid-cols-3">
            {MODES.map((m) => (
              <label key={m.value} className={`cursor-pointer rounded-md border p-3 text-sm ${mode === m.value ? 'border-brand-500 bg-brand-50' : 'border-slate-200'}`}>
                <input type="radio" name="mode" className="mr-2 accent-brand-700" checked={mode === m.value} onChange={() => changeMode(m.value)} />
                <b>{m.label}</b>
                <p className="mt-1 text-xs text-slate-500">{m.hint}</p>
              </label>
            ))}
          </div>
          {mode === 'update_allowed' && (
            <div className="mt-3">
              <p className="mb-1 text-sm font-medium">Какие поля обновлять у существующих записей</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {UPDATE_FIELDS.map((f) => (
                  <Checkbox key={f.key} label={f.label} checked={updateFields.includes(f.key)} onChange={(e) => setUpdateFields(e.target.checked ? [...updateFields, f.key] : updateFields.filter((x) => x !== f.key))} />
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">Никогда не меняются: подтверждённый менеджером адрес, контакты, комментарии, оборудование, фото, визиты, заявки, ответственный.</p>
            </div>
          )}
        </Card>

        <Card title="Направления Sillan">
          <p className="mb-2 text-sm text-slate-600">Категория 2GIS сохраняется в карточке как есть (поле «Источник»). Направления Sillan — отдельная классификация; категория не всегда совпадает с направлением.</p>
          <Checkbox label="Подбирать направления по ключевым словам из категории и названия (слова настраиваются в «Справочниках»)" checked={useKeywords} onChange={(e) => setUseKeywords(e.target.checked)} />
          <p className="mb-1 mt-3 text-sm font-medium">Добавить всем записям этого файла:</p>
          <ChipSelect options={d.activeDirections.map((x) => ({ value: x.id, label: x.name }))} value={extraDirs} onChange={setExtraDirs} />
          <p className="mt-2 text-xs text-slate-500">У существующих записей направления только добавляются (в режиме обновления — если отмечено поле «Направления»), ничего не снимается.</p>
        </Card>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
          {(['create', 'update', 'merge', 'skip', 'conflict', 'error'] as const).map((a) => (
            <button key={a} onClick={() => setFilter(a)} className={`rounded-lg border bg-white p-3 text-left ${filter === a ? 'border-brand-500' : 'border-slate-200'}`}>
              <div className="text-xs text-slate-500">{ACTION_LABEL[a]}</div>
              <div className="text-xl font-semibold tabular-nums">{sum[a]}</div>
            </button>
          ))}
        </div>
        <p className="text-sm text-slate-600">
          Всего строк: {sum.total}. Найдено в базе: {sum.existing}. Повторов внутри файла: {sum.inFile}.{' '}
          <button className="text-brand-700 underline" onClick={() => setFilter('all')}>Показать все</button>
        </p>

        {sum.conflict > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="size-4" /> {sum.conflict} строк похожи на существующие записи. Решите по каждой или для всех сразу:
            <Button size="sm" onClick={() => decideAllConflicts('create')}>Все — создать отдельно</Button>
            <Button size="sm" onClick={() => decideAllConflicts('skip')}>Все — пропустить</Button>
          </div>
        )}

        <Card bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>Стр.</th><th>Из файла</th><th>Действие</th><th>Подробности</th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.row}>
                    <td className="tabular-nums text-slate-500">{r.row}</td>
                    <td className="max-w-sm">
                      <div className="font-medium">{r.built.data.name || <span className="text-rose-600">без названия</span>}</div>
                      <div className="text-xs text-slate-500">{[r.built.data.city, r.built.data.address].filter(Boolean).join(', ')}</div>
                      <div className="text-xs text-slate-500">{r.built.data.phones.map(formatPhone).join(', ')}</div>
                      {r.built.data.category && <div className="text-xs text-slate-500">2GIS: {r.built.data.category}</div>}
                      {finalDirections(r).length > 0 && <div className="mt-0.5 flex flex-wrap gap-1">{finalDirections(r).map((id) => <Badge key={id} color="brand">{d.directionName(id)}</Badge>)}</div>}
                    </td>
                    <td><Badge color={ACTION_COLOR[r.action]}>{ACTION_LABEL[r.action]}</Badge></td>
                    <td className="max-w-md text-sm">
                      {r.message && <div className="text-slate-600">{r.message}</div>}
                      {r.built.warnings.map((w) => <div key={w} className="text-xs text-amber-700">{w}</div>)}
                      {r.preview && !r.preview.match && r.preview.possible.length > 0 && (
                        <div className="mt-1 space-y-1">
                          {r.preview.possible.map((c) => (
                            <div key={c.id} className="rounded border border-slate-200 p-1.5 text-xs">
                              <div><b>{c.name}</b> · {[c.city, c.address].filter(Boolean).join(', ')} <span className="text-amber-700">({c.reason})</span></div>
                              <Button size="sm" variant={r.action === 'merge' && r.location_id === c.id ? 'primary' : 'ghost'} className="mt-1" onClick={() => decide(r.row, { action: 'merge', location_id: c.id, message: `Объединено с «${c.name}»` })}>Объединить с этой</Button>
                            </div>
                          ))}
                          <div className="flex gap-1">
                            <Button size="sm" variant={r.action === 'create' ? 'primary' : 'secondary'} onClick={() => decide(r.row, { action: 'create', location_id: null, message: 'Создано отдельно (решение пользователя)' })}>Оставить отдельно</Button>
                            <Button size="sm" variant={r.action === 'skip' ? 'primary' : 'secondary'} onClick={() => decide(r.row, { action: 'skip', location_id: null, message: 'Пропущено (решение пользователя)' })}>Пропустить</Button>
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.filter((r) => filter === 'all' || r.action === filter).length > 300 && <p className="p-3 text-xs text-slate-500">Показаны первые 300 строк этой группы.</p>}
            {!shown.length && <p className="p-6 text-center text-sm text-slate-500">В этой группе строк нет</p>}
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {sum.conflict > 0 && <span className="text-sm text-amber-700">Нерешённые строки будут пропущены и попадут в журнал как конфликты.</span>}
          <Button onClick={() => setStep('map')}>Назад к сопоставлению</Button>
          <Button variant="primary" disabled={sum.create + sum.update + sum.merge === 0} onClick={run}>
            Импортировать: создать {sum.create}, обновить {sum.update + sum.merge}
          </Button>
        </div>
      </div>
    )
  }

  if (step === 'running') {
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0
    return (
      <Card>
        <div className="space-y-3 py-6 text-center">
          <p className="text-sm text-slate-700">Импорт… {progress.done} из {progress.total} строк</p>
          <div className="mx-auto h-2 max-w-md rounded bg-slate-100"><div className="h-2 rounded bg-brand-600 transition-all" style={{ width: `${pct}%` }} /></div>
          <p className="text-xs text-slate-500">Не закрывайте страницу до завершения. Строки обрабатываются порциями по {BATCH}.</p>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <div className="space-y-3 py-4">
        {result?.status === 'failed' || error ? (
          <div className="flex items-start gap-2 text-rose-700"><AlertTriangle className="mt-0.5 size-5" /><div><p className="font-medium">Импорт прерван</p><p className="text-sm">{humanError(error)} Уже обработанные строки сохранены — их можно увидеть в журнале. Повторный запуск того же файла не создаст дублей.</p></div></div>
        ) : (
          <div className="flex items-center gap-2 text-emerald-700"><CheckCircle2 className="size-5" /><p className="font-medium">Импорт завершён</p></div>
        )}
        {result && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[['Создано', result.created_count], ['Обновлено', result.updated_count], ['Пропущено', result.skipped_count], ['Конфликтов', result.conflict_count], ['Ошибок', result.error_count]].map(([l, v]) => (
              <div key={l} className="rounded-md border border-slate-200 p-3"><div className="text-xs text-slate-500">{l}</div><div className="text-xl font-semibold">{v}</div></div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {result && <Button onClick={() => downloadJobReport(result.id, fileName).catch((e) => toast.error(e))}>Скачать отчёт по строкам</Button>}
          <Button variant="primary" onClick={reset}>Новый импорт</Button>
        </div>
      </div>
    </Card>
  )
}
