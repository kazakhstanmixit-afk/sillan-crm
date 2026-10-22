import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/components/ui'

// --- поддельный клиент Supabase: справочники и вызов create_location ---
const tables: Record<string, unknown[]> = {
  directions: [{ id: 'd1', name: 'Автосервис / СТО', keywords: [], sort: 10, is_active: true }, { id: 'd2', name: 'Шиномонтаж', keywords: [], sort: 20, is_active: true }],
  client_statuses: [{ code: 'new', name: 'Новый', sort: 10, color: 'gray', is_active: true }],
}
const rpc = vi.fn()
function chain(table: string) {
  const result = { data: tables[table] ?? [], error: null }
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'eq', 'is', 'or', 'limit', 'in', 'ilike']) c[m] = () => c
  c.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res)
  return c
}
vi.mock('@/lib/supabase', () => ({ isConfigured: true, FILES_BUCKET: 'crm-files', supabase: { from: (t: string) => chain(t), rpc: (...a: unknown[]) => rpc(...a) } }))
vi.mock('@/auth/AuthProvider', () => ({
  usePerms: () => ({ role: 'rep', active: true, view_all: false, edit_all: false, assign: false, view_team: false, archive: false, import: false, manage_users: false, manage_dictionaries: false }),
  useAuth: () => ({ session: { user: { id: 'u1' } } }),
}))

import ClientNewPage from '../ClientNewPage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/clients/new']}>
          <Routes>
            <Route path="/clients/new" element={<ClientNewPage />} />
            <Route path="/clients/:id" element={<div>Карточка открыта</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}

describe('Форма нового клиента', () => {
  beforeEach(() => { rpc.mockReset() })

  it('не отправляет форму без названия и показывает понятную ошибку', async () => {
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить клиента' }))
    expect(await screen.findByText(/Укажите название/)).toBeInTheDocument()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('двойное нажатие создаёт клиента один раз и открывает карточку', async () => {
    let resolve!: (v: unknown) => void
    rpc.mockImplementation(() => new Promise((r) => { resolve = r }))
    renderPage()
    await userEvent.type(screen.getByLabelText(/Название точки/), 'СТО Мотор')
    await userEvent.click(await screen.findByRole('button', { name: 'Шиномонтаж' }))
    const btn = screen.getByRole('button', { name: 'Сохранить клиента' })
    await userEvent.click(btn)
    await userEvent.click(btn)
    expect(rpc).toHaveBeenCalledTimes(1)
    const [name, args] = rpc.mock.calls[0] as [string, { p: Record<string, unknown> }]
    expect(name).toBe('create_location')
    expect(args.p).toMatchObject({ name: 'СТО Мотор', direction_ids: ['d2'], status_code: 'new' })
    expect(args.p.client_request_id).toMatch(/^[0-9a-f-]{36}$/)
    resolve({ data: 'loc-1', error: null })
    expect(await screen.findByText('Карточка открыта')).toBeInTheDocument()
  })

  it('при ошибке сервера не теряет введённые данные', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } })
    renderPage()
    await userEvent.type(screen.getByLabelText(/Название точки/), 'СТО Мотор')
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить клиента' }))
    expect(await screen.findByText('Недостаточно прав для этого действия.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText(/Название точки/)).toHaveValue('СТО Мотор'))
    expect(screen.queryByText('Карточка открыта')).not.toBeInTheDocument()
  })
})
