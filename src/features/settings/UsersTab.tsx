import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil, UserPlus } from 'lucide-react'
import { Badge, Button, Card, Checkbox, Field, Input, Modal, Select, useToast } from '@/components/ui'
import { useAuth } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { fmtDate } from '@/lib/format'
import { ROLE_LABEL } from '@/lib/labels'
import type { Profile, Role } from '@/lib/types'
import { LOGIN_RE, displayLogin, toAuthEmail } from '@/lib/login'

/** Вызов серверной функции admin-users (service-role ключ только на сервере) */
async function callAdminUsers(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('admin-users', { body })
  if (error) {
    let msg = ''
    try {
      msg = (await (error as { context?: Response }).context?.json())?.error ?? ''
    } catch {
      msg = ''
    }
    if (!msg && /Failed to send|not found|404/i.test(error.message)) msg = 'Функция admin-users не развёрнута в Supabase (см. README, раздел «Пользователи»).'
    throw new Error(msg || error.message)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

export function UsersTab() {
  const d = useDicts()
  const { session } = useAuth()
  const [editing, setEditing] = useState<Profile | null>(null)
  const [creating, setCreating] = useState(false)
  const [showInactive, setShowInactive] = useState(true)
  const list = d.profiles.filter((p) => showInactive || p.is_active)
  return (
    <Card
      title="Пользователи"
      actions={<>
        <Checkbox label="Показывать неактивных" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
        <Button size="sm" variant="primary" icon={<UserPlus className="size-3.5" />} onClick={() => setCreating(true)}>Добавить сотрудника</Button>
      </>}
      bodyClassName="p-0"
    >
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead><tr><th>Сотрудник</th><th>Роль</th><th>Доступ</th><th>Статус</th><th>Создан</th><th /></tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id} className={p.is_active ? '' : 'opacity-60'}>
                <td><div className="font-medium">{p.full_name || '—'}{p.id === session?.user.id && <span className="text-xs text-slate-500"> (вы)</span>}</div><div className="text-xs text-slate-500">{displayLogin(p.email)}</div></td>
                <td>{ROLE_LABEL[p.role]}</td>
                <td className="space-x-1">
                  {p.role === 'rep' && (p.can_view_all ? <Badge color="blue">Видит всю базу</Badge> : <Badge>Только свои клиенты</Badge>)}
                  {p.can_import && p.role !== 'admin' && <Badge color="violet">Импорт</Badge>}
                </td>
                <td>{p.is_active ? <Badge color="green">Активен</Badge> : <Badge color="amber">Не активирован</Badge>}</td>
                <td className="whitespace-nowrap">{fmtDate(p.created_at)}</td>
                <td><Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(p)}>Изменить</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-3 text-xs text-slate-500">
        Пользователь, зарегистрировавшийся сам или добавленный в панели Supabase, появляется здесь неактивным — активируйте его и назначьте роль.
        Удалять сотрудников не нужно: деактивируйте, чтобы сохранить историю их работы.
      </p>
      {editing && <EditUser profile={editing} self={editing.id === session?.user.id} onClose={() => setEditing(null)} />}
      {creating && <CreateUser onClose={() => setCreating(false)} />}
    </Card>
  )
}

function EditUser({ profile, self, onClose }: { profile: Profile; self: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [v, setV] = useState({ full_name: profile.full_name, role: profile.role, is_active: profile.is_active, can_view_all: profile.can_view_all, can_import: profile.can_import })
  const [password, setPassword] = useState('')
  const save = useMutation({
    mutationFn: async () => {
      const rows = unwrap(await supabase.from('profiles').update({ ...v, full_name: v.full_name.trim() }).eq('id', profile.id).select('id'))
      if (!rows?.length) throw new Error('Недостаточно прав')
      if (password) await callAdminUsers({ action: 'set_password', user_id: profile.id, password })
    },
    onSuccess: () => { toast.success('Пользователь сохранён'); qc.invalidateQueries({ queryKey: ['dicts'] }); onClose() },
    onError: (e) => toast.error(e),
  })
  return (
    <Modal open onClose={onClose} size="sm" title={displayLogin(profile.email) || 'Пользователь'} dismissable={!save.isPending}
      footer={<><Button onClick={onClose} disabled={save.isPending}>Отмена</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Сохранить</Button></>}>
      <div className="space-y-3">
        <Field label="ФИО">{(id) => <Input id={id} value={v.full_name} onChange={(e) => setV({ ...v, full_name: e.target.value })} />}</Field>
        <Field label="Роль" hint={self ? 'Свою роль изменить нельзя' : undefined}>
          {(id) => <Select id={id} value={v.role} disabled={self} onChange={(e) => setV({ ...v, role: e.target.value as Role })}>{Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}
        </Field>
        <Checkbox label="Учётная запись активна" checked={v.is_active} disabled={self} onChange={(e) => setV({ ...v, is_active: e.target.checked })} />
        {v.role === 'rep' && <Checkbox label="Видит всю базу клиентов (редактирует только своих)" checked={v.can_view_all} onChange={(e) => setV({ ...v, can_view_all: e.target.checked })} />}
        {v.role !== 'admin' && <Checkbox label="Может импортировать данные" checked={v.can_import} onChange={(e) => setV({ ...v, can_import: e.target.checked })} />}
        <Field label="Новый пароль" hint="Оставьте пустым, чтобы не менять. Нужна развёрнутая функция admin-users.">{(id) => <Input id={id} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      </div>
    </Modal>
  )
}

function CreateUser({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [v, setV] = useState({ email: '', full_name: '', role: 'rep' as Role, can_view_all: false, can_import: false, mode: 'create' as 'create' | 'invite', password: '' })
  const login = v.email.trim().toLowerCase()
  const mut = useMutation({
    mutationFn: () => callAdminUsers({ action: v.mode, email: v.mode === 'create' ? toAuthEmail(login) : login, full_name: v.full_name, role: v.role, can_view_all: v.can_view_all, can_import: v.can_import, password: v.password, redirect_to: window.location.origin + '/settings' }),
    onSuccess: () => { toast.success(v.mode === 'invite' ? 'Приглашение отправлено' : 'Сотрудник создан'); qc.invalidateQueries({ queryKey: ['dicts'] }); onClose() },
    onError: (e) => toast.error(e),
  })
  const validLogin = v.mode === 'create'
    ? LOGIN_RE.test(login) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(login)
    : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(login)
  const valid = validLogin && v.full_name.trim().length >= 2 && (v.mode === 'invite' || v.password.length >= 8)
  return (
    <Modal open onClose={onClose} size="sm" title="Новый сотрудник" dismissable={!mut.isPending}
      footer={<><Button onClick={onClose} disabled={mut.isPending}>Отмена</Button><Button variant="primary" disabled={!valid} loading={mut.isPending} onClick={() => mut.mutate()}>{v.mode === 'invite' ? 'Отправить приглашение' : 'Создать'}</Button></>}>
      <div className="space-y-3">
        <Field label={v.mode === 'create' ? 'Логин' : 'E-mail'} required
          hint={v.mode === 'create' ? 'Латиница, цифры, точка, «_» или «-», от 2 символов (например erlan.t). Можно указать и e-mail.' : 'На этот адрес придёт письмо-приглашение'}
          error={login && !validLogin ? (v.mode === 'create' ? 'Только латиница, цифры, «.», «_», «-»' : 'Введите корректный e-mail') : undefined}>
          {(id) => <Input id={id} type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />}
        </Field>
        <Field label="ФИО" required>{(id) => <Input id={id} value={v.full_name} onChange={(e) => setV({ ...v, full_name: e.target.value })} />}</Field>
        <Field label="Роль">{(id) => <Select id={id} value={v.role} onChange={(e) => setV({ ...v, role: e.target.value as Role })}>{Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        {v.role === 'rep' && <Checkbox label="Видит всю базу клиентов" checked={v.can_view_all} onChange={(e) => setV({ ...v, can_view_all: e.target.checked })} />}
        {v.role !== 'admin' && <Checkbox label="Может импортировать данные" checked={v.can_import} onChange={(e) => setV({ ...v, can_import: e.target.checked })} />}
        <Field label="Способ">
          {(id) => <Select id={id} value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value as 'create' | 'invite' })}><option value="create">Логин и пароль (задаю сам)</option><option value="invite">Приглашение на e-mail</option></Select>}
        </Field>
        {v.mode === 'create' && <Field label="Пароль" required hint="Не короче 8 символов; сотрудник сможет сменить его в профиле">{(id) => <Input id={id} type="password" autoComplete="new-password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} />}</Field>}
      </div>
    </Modal>
  )
}
