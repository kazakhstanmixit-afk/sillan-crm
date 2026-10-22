// Помощники для тестов базы: каждая тестовая сессия создаёт отдельную временную БД
// на локальном PostgreSQL (TEST_DATABASE_URL), применяет заглушку Supabase и все миграции,
// а в конце удаляет её. Рабочая база не затрагивается.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'

export const TEST_DB_URL = process.env.TEST_DATABASE_URL

const root = join(import.meta.dirname, '..', '..')

export type Role = 'admin' | 'head' | 'rep'

export class TestDb {
  constructor(
    public pool: pg.Pool,
    private admin: pg.Client,
    private dbName: string,
  ) {}

  /** Запрос от имени владельца БД (как миграции; RLS не действует). */
  async sql<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
    return (await this.pool.query<T>(text, params)).rows
  }

  /** Выполнить действия от имени пользователя CRM — так же, как запрос из браузера через Supabase. */
  async as<T>(uid: string, fn: (q: <R extends pg.QueryResultRow = any>(text: string, params?: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T> {
    const c = await this.pool.connect()
    try {
      await c.query('begin')
      await c.query('set local role authenticated')
      await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid])
      const res = await fn(async (text, params = []) => (await c.query(text, params)).rows)
      await c.query('commit')
      return res
    } catch (e) {
      await c.query('rollback')
      throw e
    } finally {
      c.release()
    }
  }

  async createUser(fullName: string, role: Role, opts: { active?: boolean; canViewAll?: boolean; canImport?: boolean } = {}) {
    const [u] = await this.sql<{ id: string }>(
      `insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('full_name', $2::text, 'role', 'admin')) returning id`,
      [`${fullName.toLowerCase().replace(/\s+/g, '.')}@test.local`, fullName],
    )
    await this.sql(
      `update public.profiles set role = $2, is_active = $3, can_view_all = $4, can_import = $5 where id = $1`,
      [u.id, role, opts.active ?? true, opts.canViewAll ?? false, opts.canImport ?? false],
    )
    return u.id
  }

  async close() {
    await this.pool.end()
    await this.admin.query(`drop database if exists ${this.dbName} with (force)`)
    await this.admin.end()
  }
}

export async function setupTestDb(): Promise<TestDb> {
  if (!TEST_DB_URL) throw new Error('TEST_DATABASE_URL не задан')
  const admin = new pg.Client({ connectionString: TEST_DB_URL })
  await admin.connect()
  const dbName = `crm_t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  await admin.query(`create database ${dbName}`)
  const url = new URL(TEST_DB_URL)
  url.pathname = '/' + dbName
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
  const files = [
    join(root, 'tests/db/supabase_stub.sql'),
    ...readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort().map((f) => join(root, 'supabase/migrations', f)),
  ]
  for (const f of files) {
    try {
      await pool.query(readFileSync(f, 'utf8'))
    } catch (e) {
      throw new Error(`Ошибка миграции ${f}: ${(e as Error).message}`)
    }
  }
  return new TestDb(pool, admin, dbName)
}

/** Ожидать ошибку Postgres (например, нарушение RLS или ограничения). */
export async function expectPgError(p: Promise<unknown>, match?: RegExp | string) {
  let err: any
  try {
    await p
  } catch (e) {
    err = e
  }
  if (!err) throw new Error('Ожидалась ошибка, но запрос выполнился')
  if (match && !(typeof match === 'string' ? String(err.message).includes(match) : match.test(String(err.message)))) {
    throw new Error(`Ошибка не та: ${err.message}`)
  }
  return err
}
