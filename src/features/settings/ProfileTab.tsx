import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Field, Input, useToast } from '@/components/ui'
import { useAuth, usePerms } from '@/auth/AuthProvider'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { ROLE_LABEL } from '@/lib/labels'
import { displayLogin, isLoginAccount } from '@/lib/login'

export function ProfileTab() {
  const { profile } = useAuth()
  const perms = usePerms()
  const qc = useQueryClient()
  const toast = useToast()
  const [name, setName] = useState(profile?.full_name ?? '')
  const [phone, setPhone] = useState(profile?.phone ?? '')
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')

  const save = useMutation({
    mutationFn: async () => unwrap(await supabase.rpc('update_my_profile', { p_full_name: name, p_phone: phone })),
    onSuccess: () => { toast.success('Профиль сохранён'); qc.invalidateQueries({ queryKey: ['me'] }); qc.invalidateQueries({ queryKey: ['dicts'] }) },
    onError: (e) => toast.error(e),
  })
  const changePass = useMutation({
    mutationFn: async () => {
      if (pass.length < 8) throw new Error('Пароль — не короче 8 символов')
      if (pass !== pass2) throw new Error('Пароли не совпадают')
      const { error } = await supabase.auth.updateUser({ password: pass })
      if (error) throw error
    },
    onSuccess: () => { toast.success('Пароль изменён'); setPass(''); setPass2('') },
    onError: (e) => toast.error(e),
  })

  return (
    <div className="grid max-w-4xl gap-4 lg:grid-cols-2">
      <Card title="Профиль">
        <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} className="space-y-3">
          <Field label={isLoginAccount(profile?.email) ? 'Логин' : 'E-mail'}>{(id) => <Input id={id} value={displayLogin(profile?.email)} disabled />}</Field>
          <Field label="Роль" hint="Роль назначает администратор">{(id) => <Input id={id} value={perms.role ? ROLE_LABEL[perms.role] : ''} disabled />}</Field>
          <Field label="ФИО" required>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />}</Field>
          <Field label="Телефон">{(id) => <Input id={id} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={50} />}</Field>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={name.trim().length < 2}>Сохранить</Button>
        </form>
      </Card>
      <Card title="Смена пароля">
        <form onSubmit={(e) => { e.preventDefault(); changePass.mutate() }} className="space-y-3">
          <Field label="Новый пароль" hint="Не короче 8 символов">{(id) => <Input id={id} type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />}</Field>
          <Field label="Повторите пароль">{(id) => <Input id={id} type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />}</Field>
          <Button type="submit" variant="primary" loading={changePass.isPending} disabled={!pass}>Изменить пароль</Button>
        </form>
      </Card>
    </div>
  )
}
