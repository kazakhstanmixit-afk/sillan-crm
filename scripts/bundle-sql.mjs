// Склеивает все миграции в один файл supabase/all_migrations.sql —
// удобно, чтобы один раз выполнить в Supabase → SQL Editor на НОВОМ проекте.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = join(import.meta.dirname, '..', 'supabase', 'migrations')
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
const out = ['-- Sillan CRM: все миграции одним файлом. Сгенерировано scripts/bundle-sql.mjs — не редактируйте вручную.',
  '-- Выполняйте только на новом, пустом проекте Supabase. Для обновлений используйте отдельные файлы из supabase/migrations.', '']
for (const f of files) out.push(`-- ===== ${f} =====`, readFileSync(join(dir, f), 'utf8'), '')
writeFileSync(join(dir, '..', 'all_migrations.sql'), out.join('\n'))
console.log(`supabase/all_migrations.sql: ${files.length} миграций`)
