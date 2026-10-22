// Supabase Edge Function: управление учётными записями сотрудников CRM.
// Вызывается только администратором CRM (проверяется по таблице profiles).
// Service-role ключ используется ТОЛЬКО здесь, на сервере, и никогда не попадает в браузер.
//
// Развёртывание:  supabase functions deploy admin-users
// Переменные SUPABASE_URL, SUPABASE_ANON_KEY и SUPABASE_SERVICE_ROLE_KEY Supabase передаёт функции автоматически.
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const ROLES = ['admin', 'head', 'rep']

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Метод не поддерживается' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const authHeader = req.headers.get('Authorization') ?? ''

  // кто вызывает
  const asCaller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } })
  const { data: userData, error: userErr } = await asCaller.auth.getUser()
  if (userErr || !userData.user) return json({ error: 'Не выполнен вход' }, 401)

  const admin = createClient(url, service, { auth: { persistSession: false } })
  const { data: me } = await admin.from('profiles').select('role, is_active').eq('id', userData.user.id).maybeSingle()
  if (!me || me.role !== 'admin' || !me.is_active) return json({ error: 'Только администратор CRM может управлять пользователями' }, 403)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Неверный формат запроса' }, 400)
  }
  const action = String(body.action ?? '')
  const email = String(body.email ?? '').trim().toLowerCase()
  const fullName = String(body.full_name ?? '').trim().slice(0, 200)
  const role = ROLES.includes(String(body.role)) ? String(body.role) : 'rep'

  try {
    if (action === 'create' || action === 'invite') {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Укажите корректный логин или e-mail' }, 400)
      let userId: string
      if (action === 'create') {
        const password = String(body.password ?? '')
        if (password.length < 8) return json({ error: 'Пароль — не короче 8 символов' }, 400)
        const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } })
        if (error) return json({ error: error.message.includes('already') ? 'Такой логин или e-mail уже занят' : error.message }, 400)
        userId = data.user.id
      } else {
        const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
          data: { full_name: fullName },
          redirectTo: typeof body.redirect_to === 'string' ? body.redirect_to : undefined,
        })
        if (error) return json({ error: error.message.includes('already') ? 'Пользователь с таким e-mail уже есть' : error.message }, 400)
        userId = data.user.id
      }
      const { error: pErr } = await admin.from('profiles').update({
        full_name: fullName, role, is_active: true,
        can_view_all: Boolean(body.can_view_all), can_import: Boolean(body.can_import),
      }).eq('id', userId)
      if (pErr) return json({ error: pErr.message }, 400)
      return json({ id: userId })
    }

    if (action === 'set_password') {
      const id = String(body.user_id ?? '')
      const password = String(body.password ?? '')
      if (password.length < 8) return json({ error: 'Пароль — не короче 8 символов' }, 400)
      const { error } = await admin.auth.admin.updateUserById(id, { password })
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    return json({ error: 'Неизвестное действие' }, 400)
  } catch (e) {
    console.error(e)
    return json({ error: 'Внутренняя ошибка функции' }, 500)
  }
})
