import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader, Tabs } from '@/components/ui'
import { usePerms } from '@/auth/AuthProvider'
import { ProfileTab } from './ProfileTab'
import { UsersTab } from './UsersTab'
import { DictionariesTab } from './DictionariesTab'
import { DailyReportTab } from './DailyReportTab'
import { BitrixDealsTab } from './BitrixDealsTab'

type Tab = 'profile' | 'users' | 'dicts' | 'report' | 'bitrix'

export default function SettingsPage() {
  const perms = usePerms()
  const [params] = useSearchParams()
  const initial = (params.get('tab') as Tab) || 'profile'
  const [tab, setTab] = useState<Tab>((initial === 'users' || initial === 'report' || initial === 'bitrix') && !perms.manage_users ? 'profile' : initial)
  return (
    <div>
      <PageHeader title="Настройки и справочники" />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'profile', label: 'Мой профиль' },
          ...(perms.manage_users ? [{ value: 'users' as const, label: 'Пользователи и роли' }] : []),
          { value: 'dicts', label: 'Справочники' },
          ...(perms.manage_users ? [{ value: 'report' as const, label: 'Отчёт в Битрикс24' }, { value: 'bitrix' as const, label: 'Сделки в Битрикс24' }] : []),
        ]}
      />
      <div className="mt-4">
        {tab === 'profile' && <ProfileTab />}
        {tab === 'users' && perms.manage_users && <UsersTab />}
        {tab === 'dicts' && <DictionariesTab />}
        {tab === 'report' && perms.manage_users && <DailyReportTab />}
        {tab === 'bitrix' && perms.manage_users && <BitrixDealsTab />}
      </div>
    </div>
  )
}
