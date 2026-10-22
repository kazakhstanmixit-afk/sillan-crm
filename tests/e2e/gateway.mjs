// Локальный «мини-Supabase» для сквозной проверки интерфейса в браузере:
//   /rest/v1    → PostgREST (настоящий, с RLS)
//   /auth/v1    → упрощённая имитация входа (пароль e2e-password для пользователей из auth.users)
//   /storage/v1 → хранение файлов в памяти (политики хранилища здесь НЕ проверяются — они проверены в тестах БД)
//   остальное   → собранное приложение из dist/
// Только для тестов. Не использовать в рабочем окружении.
import http from 'node:http'
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import pg from 'pg'

const { PORT = '54321', PGRST_PORT, DB_URL, JWT_SECRET, DIST } = process.env
const pool = new pg.Pool({ connectionString: DB_URL, max: 2 })
const files = new Map()

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function sign(user) {
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })
  return `${head}.${body}.${createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url')}`
}
function verify(token) {
  const [h, b, s] = (token ?? '').split('.')
  if (!s || createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url') !== s) return null
  return JSON.parse(Buffer.from(b, 'base64url').toString())
}
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))) })
const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', ...headers })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}
const userJson = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() })
const session = (u) => ({ access_token: sign(u), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'rt-' + u.id, user: userJson(u) })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '')
    if (url.pathname.startsWith('/rest/v1')) {
      const fwd = http.request({ host: '127.0.0.1', port: PGRST_PORT, path: url.pathname.replace('/rest/v1', '') + url.search, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${PGRST_PORT}` } }, (r) => {
        res.writeHead(r.statusCode, { ...r.headers, 'access-control-allow-origin': '*' })
        r.pipe(res)
      })
      req.pipe(fwd)
      return
    }
    if (url.pathname === '/auth/v1/token') {
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        const id = String(body.refresh_token ?? '').replace('rt-', '')
        const { rows } = await pool.query('select id, email from auth.users where id::text = $1', [id])
        return rows[0] ? send(res, 200, session(rows[0])) : send(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' })
      }
      const { rows } = await pool.query('select id, email from auth.users where lower(email) = lower($1)', [body.email ?? ''])
      if (!rows[0] || body.password !== 'e2e-password') return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials' })
      return send(res, 200, session(rows[0]))
    }
    if (url.pathname === '/auth/v1/user') {
      const claims = verify((req.headers.authorization ?? '').replace('Bearer ', ''))
      if (!claims) return send(res, 401, { msg: 'invalid JWT' })
      if (req.method === 'PUT') return send(res, 200, userJson({ id: claims.sub, email: claims.email }))
      return send(res, 200, userJson({ id: claims.sub, email: claims.email }))
    }
    if (url.pathname === '/auth/v1/logout') return send(res, 204, '')
    if (url.pathname.startsWith('/storage/v1/object/sign/')) {
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString())
        const bucket = url.pathname.split('/')[5]
        return send(res, 200, (body.paths ?? []).map((p) => ({ path: p, signedURL: `/storage/v1/object/public-e2e/${bucket}/${p}?token=x`, error: files.has(`${bucket}/${p}`) ? null : 'not found' })))
      }
    }
    if (url.pathname.startsWith('/storage/v1/object/public-e2e/')) {
      const key = decodeURIComponent(url.pathname.replace('/storage/v1/object/public-e2e/', ''))
      const f = files.get(key)
      return f ? send(res, 200, f.data, { 'content-type': f.type }) : send(res, 404, { error: 'not found' })
    }
    if (url.pathname.startsWith('/storage/v1/object/')) {
      const rest = decodeURIComponent(url.pathname.replace('/storage/v1/object/', ''))
      if (req.method === 'POST' || req.method === 'PUT') {
        if (!verify((req.headers.authorization ?? '').replace('Bearer ', ''))) return send(res, 401, { error: 'unauthorized' })
        files.set(rest, { data: await readBody(req), type: req.headers['content-type'] ?? 'application/octet-stream' })
        return send(res, 200, { Key: rest, Id: randomUUID() })
      }
      if (req.method === 'DELETE') {
        const body = JSON.parse((await readBody(req)).toString() || '{}')
        for (const p of body.prefixes ?? []) files.delete(`${rest}/${p}`)
        return send(res, 200, [])
      }
    }
    if (url.pathname.startsWith('/functions/v1/')) return send(res, 404, { error: 'Function not found' })
    // приложение
    let p = join(DIST, url.pathname)
    if (!existsSync(p) || url.pathname === '/' || !extname(p)) p = join(DIST, 'index.html')
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' })
    res.end(readFileSync(p))
  } catch (e) {
    console.error(e)
    send(res, 500, { error: String(e) })
  }
}).listen(Number(PORT), '127.0.0.1', () => console.log('gateway on', PORT))
