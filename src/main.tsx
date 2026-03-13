import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { toast } from 'sonner'
import App from './app'
import './index.css'
import { flushOfflineQueue } from './lib/offlineQueue'
import { translate } from './lib/i18n'

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    toast(translate('toast.newVersion'), {
      duration: Infinity,
      action: {
        label: translate('toast.reload'),
        onClick: () => updateSW(true),
      },
    })
  },
})

window.addEventListener('online', () => flushOfflineQueue().catch(() => {}))
if (navigator.onLine) flushOfflineQueue().catch(() => {})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
