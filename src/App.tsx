import { lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { isConfigured } from '@/lib/supabase'
import { AuthProvider, useAuth } from '@/auth/AuthProvider'
import { LoginPage } from '@/auth/LoginPage'
import { InactivePage, NotConfiguredPage } from '@/auth/StatusPages'
import { AppLayout } from '@/components/layout/AppLayout'
import { Spinner, ToastProvider } from '@/components/ui'

const DashboardPage = lazy(() => import('@/features/dashboard/DashboardPage'))
const ClientsPage = lazy(() => import('@/features/clients/ClientsPage'))
const ClientNewPage = lazy(() => import('@/features/clients/ClientNewPage'))
const ClientPage = lazy(() => import('@/features/clients/ClientPage'))
const ImportPage = lazy(() => import('@/features/import/ImportPage'))
const PlanPage = lazy(() => import('@/features/visits/PlanPage'))
const VisitsPage = lazy(() => import('@/features/visits/VisitsPage'))
const RequestsPage = lazy(() => import('@/features/requests/RequestsPage'))
const RequestPage = lazy(() => import('@/features/requests/RequestPage'))
const TeamPage = lazy(() => import('@/features/team/TeamPage'))
const AnalyticsPage = lazy(() => import('@/features/analytics/AnalyticsPage'))
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 20_000 },
    mutations: { retry: 0 },
  },
})

function Protected({ children }: { children: ReactNode }) {
  const { session, loading, perms, permsLoading } = useAuth()
  if (loading || (session && permsLoading)) return <Spinner className="h-full" />
  if (!session) return <Navigate to="/login" replace />
  if (!perms?.active) return <InactivePage />
  return <>{children}</>
}

export function App() {
  if (!isConfigured) return <NotConfiguredPage />
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <Suspense fallback={<Spinner className="h-full" />}>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route element={<Protected><AppLayout /></Protected>}>
                  <Route index element={<DashboardPage />} />
                  <Route path="clients" element={<ClientsPage />} />
                  <Route path="clients/new" element={<ClientNewPage />} />
                  <Route path="clients/:id" element={<ClientPage />} />
                  <Route path="import" element={<ImportPage />} />
                  <Route path="plan" element={<PlanPage />} />
                  <Route path="visits" element={<VisitsPage />} />
                  <Route path="requests" element={<RequestsPage />} />
                  <Route path="requests/:id" element={<RequestPage />} />
                  <Route path="deals" element={<Navigate to="/requests" replace />} />
                  <Route path="team" element={<TeamPage />} />
                  <Route path="analytics" element={<AnalyticsPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </Suspense>
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  )
}
