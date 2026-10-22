import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { supabase } from '@/lib/supabase'
import { useAuth } from './AuthProvider'
import { Button, Field, Input } from '@/components/ui'

const schema = z.object({
  email: z.string().trim().email('Введите корректный e-mail'),
  password: z.string().min(6, 'Минимум 6 символов'),
})
type Form = z.infer<typeof schema>

export function LoginPage() {
  const { session } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [resetSent, setResetSent] = useState(false)
  const { register, handleSubmit, getValues, formState: { errors, isSubmitting } } = useForm<Form>({ resolver: zodResolver(schema) })

  if (session) return <Navigate to="/" replace />

  const onSubmit = async (v: Form) => {
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email: v.email, password: v.password })
    if (error) {
      setError(/invalid/i.test(error.message) ? 'Неверный e-mail или пароль' : /fetch/i.test(error.message) ? 'Нет соединения с сервером' : 'Не удалось войти. Повторите попытку.')
    }
  }

  const reset = async () => {
    const email = getValues('email')
    if (!z.string().email().safeParse(email).success) {
      setError('Введите e-mail, чтобы восстановить пароль')
      return
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + '/settings?tab=profile' })
    if (error) setError('Не удалось отправить письмо. Повторите позже.')
    else setResetSent(true)
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-brand-900 p-4">
      <form onSubmit={handleSubmit(onSubmit)} className="w-full max-w-sm space-y-4 rounded-xl bg-white p-6 shadow-xl" noValidate>
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-8" />
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Sillan CRM</h1>
            <p className="text-xs text-slate-500">Вход для сотрудников</p>
          </div>
        </div>
        <Field label="E-mail" error={errors.email?.message}>
          {(id) => <Input id={id} type="email" autoComplete="username" aria-invalid={!!errors.email} {...register('email')} />}
        </Field>
        <Field label="Пароль" error={errors.password?.message}>
          {(id) => <Input id={id} type="password" autoComplete="current-password" aria-invalid={!!errors.password} {...register('password')} />}
        </Field>
        {error && <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">{error}</p>}
        {resetSent && <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Письмо для смены пароля отправлено.</p>}
        <Button type="submit" variant="primary" className="w-full" loading={isSubmitting}>Войти</Button>
        <button type="button" onClick={reset} className="w-full text-center text-xs text-brand-600 hover:underline">Забыли пароль?</button>
        <p className="text-center text-xs text-slate-400">Учётные записи создаёт администратор CRM.</p>
      </form>
    </div>
  )
}
